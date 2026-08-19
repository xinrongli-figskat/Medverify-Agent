import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentClient } from "agents/client";
import { getToolName, isToolUIPart } from "ai";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const casesUrl = new URL("../tests/reliability/cases.json", import.meta.url);
const runsUrl = new URL("../runs_raw/", import.meta.url);
const args = parseArgs(process.argv.slice(2));
const defaultForbiddenOutputPatterns = [
  "<tool_call>",
  "tool_call",
  "arg_key",
  "arg_value"
];
const PERSISTENCE_POLL_INTERVAL_MS = 200;
const PERSISTENCE_OBSERVATION_WINDOW_MS = 5000;
const MAX_POLL_SNAPSHOTS = 26;

let cases;
try {
  cases = JSON.parse(await readFile(casesUrl, "utf8"));
} catch (error) {
  fail(`无法读取 cases.json：${messageOf(error)}`);
}

if (!Array.isArray(cases) || cases.length === 0) {
  fail("cases.json 必须是非空数组。");
}

const duplicateIds = cases
  .map((item) => item?.id)
  .filter(
    (id, index, ids) => typeof id === "string" && ids.indexOf(id) !== index
  );
if (duplicateIds.length > 0) {
  fail(`cases.json 存在重复 ID：${[...new Set(duplicateIds)].join(", ")}`);
}

if (args.evaluateRunPath) {
  const runPath = resolve(process.cwd(), args.evaluateRunPath);
  let rawRun;
  try {
    rawRun = JSON.parse(await readFile(runPath, "utf8"));
  } catch (error) {
    fail(`无法读取或解析 run JSON：${messageOf(error)}`);
  }

  const evaluationCase = cases.find((item) => item.id === rawRun.caseId);
  if (!evaluationCase) fail(`run 对应的 case 不存在：${rawRun.caseId}`);

  const evaluation = evaluateRun(evaluationCase, rawRun);
  console.log(
    JSON.stringify(
      {
        mode: "offline-evaluation",
        sourceRun: runPath,
        caseId: rawRun.caseId,
        originalVerdict: rawRun.verdict ?? null,
        ...evaluation
      },
      null,
      2
    )
  );
  process.exit(evaluation.verdict === "FAIL" ? 1 : 0);
}

if (args.selfTest) {
  await runSelfTests();
  process.exit(0);
}

if (args.dryRun) {
  const selected = args.caseId
    ? cases.find((item) => item.id === args.caseId)
    : null;
  if (args.caseId && !selected) fail(`未找到 case：${args.caseId}`);

  console.log("Reliability runner dry-run 通过；未建立网络连接。 ");
  console.log(`可用 case：${cases.length} 条。`);
  if (selected) {
    console.log(`已选择：${selected.id} ${selected.name}`);
    console.log(
      `Agent：ChatAgent；实例：${args.agentName ?? "实际运行时自动生成独立实例"}`
    );
    console.log(`Base URL：${args.baseUrl ?? "实际运行时必须提供"}`);
  }
  process.exit(0);
}

if (!args.caseId) fail("实际运行必须提供 --case <CASE_ID>。");
if (!args.baseUrl) fail("实际运行必须提供 --base-url <URL>。");

const reliabilityCase = cases.find((item) => item.id === args.caseId);
if (!reliabilityCase) fail(`未找到 case：${args.caseId}`);

let baseUrl;
try {
  baseUrl = new URL(args.baseUrl);
} catch {
  fail(`无效的 --base-url：${args.baseUrl}`);
}
if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
  fail("--base-url 只支持 http 或 https。");
}

const normalizedBaseUrl = baseUrl.href.replace(/\/$/, "");
const startedAt = Date.now();
const timestamp = new Date().toISOString();
const runId = `${timestamp.replace(/[:.]/g, "-")}_${reliabilityCase.id}`;
const agentName =
  args.agentName ?? createIsolatedAgentName(reliabilityCase.id, timestamp);
const sessionIsolated = args.agentName === null;

const errors = [];
let client;
let finalMessages = [];
let requestId = null;
let userMessageId = null;
let initialMessageCount = null;
let streamDiagnostics = createStreamDiagnostics();
let persistenceDiagnostics = createPersistenceDiagnostics();

try {
  const existingMessages = await getMessages(normalizedBaseUrl, agentName);
  initialMessageCount = existingMessages.length;

  if (sessionIsolated && initialMessageCount !== 0) {
    throw new Error(
      `独立 Agent 实例不应包含历史消息，实际发现 ${initialMessageCount} 条`
    );
  }

  userMessageId = crypto.randomUUID();
  const userMessage = {
    id: userMessageId,
    role: "user",
    parts: [{ type: "text", text: reliabilityCase.userInput }]
  };
  const messages = [...existingMessages, userMessage];
  requestId = crypto.randomUUID();

  client = new AgentClient({
    agent: "ChatAgent",
    name: agentName,
    host: normalizedBaseUrl
  });
  await withTimeout(
    client.ready,
    args.timeoutMs,
    "等待 Agent WebSocket 连接超时"
  );

  const turnResult = await waitForTurn(
    client,
    requestId,
    messages,
    args.timeoutMs
  );
  streamDiagnostics = turnResult.diagnostics;
  const observation = await observePersistence(
    normalizedBaseUrl,
    agentName,
    userMessageId
  );
  finalMessages = observation.messages;
  persistenceDiagnostics = observation.diagnostics;
} catch (error) {
  if (error?.diagnostics) streamDiagnostics = error.diagnostics;
  errors.push(messageOf(error));
} finally {
  client?.close(1000, "Reliability run complete");
}

const assistantMessage = findAssistantMessageForUser(
  finalMessages,
  userMessageId
);

if (!assistantMessage && errors.length === 0) {
  errors.push("没有找到本次用户消息之后的 assistant message");
}

const toolCalls = extractToolCalls(assistantMessage);
const finalAnswer = extractFinalAnswer(assistantMessage);
if (persistenceDiagnostics.finalAnswerExtractedAt === null) {
  persistenceDiagnostics.finalAnswerExtractedAt = new Date().toISOString();
}
const evaluation = evaluateRun(reliabilityCase, {
  errors,
  toolCalls,
  finalAnswer
});

const run = {
  runId,
  caseId: reliabilityCase.id,
  timestamp,
  gitCommit: git(["rev-parse", "HEAD"]),
  dirtyWorktree: git(["status", "--porcelain"]).length > 0,
  baseUrl: normalizedBaseUrl,
  agent: "ChatAgent",
  agentClass: "ChatAgent",
  agentName,
  sessionIsolated,
  initialMessageCount,
  messageCount: finalMessages.length,
  requestId,
  userMessageId,
  userInput: reliabilityCase.userInput,
  toolCallCount: toolCalls.length,
  toolCalls,
  finalAnswer,
  diagnostics: {
    version: 1,
    ...streamDiagnostics,
    ...persistenceDiagnostics,
    finalAnswerSource: "assistant.text_parts",
    assistantSummary: summarizeAssistantMessage(assistantMessage)
  },
  durationMs: Date.now() - startedAt,
  errors,
  toolErrors: evaluation.toolErrors,
  verdict: evaluation.verdict,
  assertionResults: evaluation.assertionResults
};

await mkdir(runsUrl, { recursive: true });
const outputUrl = new URL(`${runId}.json`, runsUrl);
await writeFile(outputUrl, `${JSON.stringify(run, null, 2)}\n`, "utf8");
console.log(`Run 已保存：${fileURLToPath(outputUrl)}`);
console.log(`Verdict：${evaluation.verdict}`);
if (evaluation.verdict === "FAIL") process.exitCode = 1;

function createIsolatedAgentName(caseId, timestamp) {
  const safeCaseId =
    caseId
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "case";

  const compactTimestamp = timestamp.replace(/\D/g, "").slice(0, 14);
  const suffix = crypto.randomUUID().slice(0, 8);

  return `reliability-${safeCaseId}-${compactTimestamp}-${suffix}`;
}
function parseArgs(argv) {
  const result = {
    caseId: null,
    baseUrl: null,
    agentName: null,
    timeoutMs: 120000,
    dryRun: false,
    selfTest: false,
    evaluateRunPath: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      result.dryRun = true;
      continue;
    }
    if (arg === "--self-test") {
      result.selfTest = true;
      continue;
    }
    if (arg === "--evaluate-run")
      result.evaluateRunPath = requiredValue(argv, ++index, arg);
    else if (arg === "--case")
      result.caseId = requiredValue(argv, ++index, arg);
    else if (arg === "--base-url")
      result.baseUrl = requiredValue(argv, ++index, arg);
    else if (arg === "--agent-name")
      result.agentName = requiredValue(argv, ++index, arg);
    else if (arg === "--timeout-ms") {
      const value = Number(requiredValue(argv, ++index, arg));
      if (!Number.isInteger(value) || value < 1000) {
        fail("--timeout-ms 必须是大于等于 1000 的整数。");
      }
      result.timeoutMs = value;
    } else fail(`未知参数：${arg}`);
  }
  return result;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) fail(`${flag} 缺少值。`);
  return value;
}

function waitForTurn(agent, requestId, messages, timeoutMs) {
  return new Promise((resolve, reject) => {
    const diagnostics = createStreamDiagnostics();
    const rejectWithDiagnostics = (error, status) => {
      diagnostics.responseStatus = status;
      error.diagnostics = diagnostics;
      reject(error);
    };
    const timeout = setTimeout(() => {
      cleanup();
      rejectWithDiagnostics(
        new Error(`Agent turn 在 ${timeoutMs}ms 内未完成`),
        "timeout"
      );
    }, timeoutMs);

    const onMessage = (event) => {
      if (typeof event.data !== "string") return;
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        return;
      }
      if (data.type !== "cf_agent_use_chat_response" || data.id !== requestId) {
        return;
      }
      diagnostics.matchingFrameCount += 1;
      inspectUiBody(data.body, diagnostics);
      if (data.error) {
        diagnostics.errorFrameCount += 1;
        diagnostics.responseStatus = "error";
        cleanup();
        rejectWithDiagnostics(
          new Error(data.body || "Agent stream error"),
          "error"
        );
      } else if (data.done) {
        diagnostics.doneFrameCount += 1;
        diagnostics.responseStatus = "completed";
        diagnostics.requestCompletedAt = new Date().toISOString();
        cleanup();
        resolve({ status: "completed", diagnostics });
      }
    };

    const onClose = () => {
      cleanup();
      rejectWithDiagnostics(
        new Error("Agent WebSocket 在 turn 完成前关闭"),
        "closed"
      );
    };

    const cleanup = () => {
      clearTimeout(timeout);
      agent.removeEventListener("message", onMessage);
      agent.removeEventListener("close", onClose);
    };

    agent.addEventListener("message", onMessage);
    agent.addEventListener("close", onClose);
    agent.send(
      JSON.stringify({
        id: requestId,
        init: {
          method: "POST",
          body: JSON.stringify({
            messages,
            trigger: "submit-message"
          })
        },
        type: "cf_agent_use_chat_request"
      })
    );
  });
}

function createStreamDiagnostics() {
  return {
    responseStatus: "not_completed",
    matchingFrameCount: 0,
    doneFrameCount: 0,
    errorFrameCount: 0,
    malformedFrameCount: 0,
    uiChunkTypeCounts: {},
    uiFinishSeen: false,
    uiFinishReason: null,
    requestCompletedAt: null
  };
}

function inspectUiBody(body, diagnostics) {
  if (body === undefined || body === null || body === "") return;
  if (typeof body !== "string") {
    diagnostics.malformedFrameCount += 1;
    return;
  }

  const trimmedBody = body.trim();
  let candidates;
  try {
    JSON.parse(trimmedBody);
    candidates = [trimmedBody];
  } catch {
    candidates = body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .filter((line) => line !== "" && line !== "[DONE]");
  }

  if (candidates.length === 0) {
    if (body.trim() !== "" && body.trim() !== "[DONE]") {
      diagnostics.malformedFrameCount += 1;
    }
    return;
  }

  for (const candidate of candidates) {
    try {
      const chunk = JSON.parse(candidate);
      if (
        !chunk ||
        typeof chunk !== "object" ||
        typeof chunk.type !== "string"
      ) {
        diagnostics.malformedFrameCount += 1;
        continue;
      }
      diagnostics.uiChunkTypeCounts[chunk.type] =
        (diagnostics.uiChunkTypeCounts[chunk.type] ?? 0) + 1;
      if (chunk.type === "finish") {
        diagnostics.uiFinishSeen = true;
        if (typeof chunk.finishReason === "string") {
          diagnostics.uiFinishReason = chunk.finishReason;
        }
      }
    } catch {
      diagnostics.malformedFrameCount += 1;
    }
  }
}

async function getMessages(base, agentName, timeoutMs = null) {
  const response = await fetch(
    `${base}/agents/chat-agent/${encodeURIComponent(agentName)}/get-messages`,
    timeoutMs === null ? undefined : { signal: AbortSignal.timeout(timeoutMs) }
  );
  if (!response.ok) {
    throw new Error(
      `get-messages 失败：HTTP ${response.status} ${response.statusText}`
    );
  }
  const messages = await response.json();
  if (!Array.isArray(messages)) throw new Error("get-messages 未返回消息数组");
  return messages;
}

function createPersistenceDiagnostics() {
  return {
    pollingAttempts: 0,
    pollingElapsedMs: 0,
    completionCriterion: "not_observed",
    assistantChangedDuringPolling: false,
    firstAssistantObservedAt: null,
    finalAnswerExtractedAt: null,
    pollSnapshots: []
  };
}

async function observePersistence(base, agentName, userMessageId) {
  const startedAt = Date.now();
  const diagnostics = createPersistenceDiagnostics();
  let messages = [];
  let previousComparable = null;
  let stableConsecutiveCount = 0;

  while (diagnostics.pollSnapshots.length < MAX_POLL_SNAPSHOTS) {
    const remainingBeforeGet =
      PERSISTENCE_OBSERVATION_WINDOW_MS - (Date.now() - startedAt);
    if (remainingBeforeGet <= 0) {
      diagnostics.completionCriterion = "observation_window_elapsed";
      break;
    }
    try {
      messages = await getMessages(base, agentName, remainingBeforeGet);
    } catch (error) {
      if (error?.name === "TimeoutError") {
        diagnostics.completionCriterion = "observation_window_elapsed";
        break;
      }
      throw error;
    }
    const assistant = findAssistantMessageForUser(messages, userMessageId);
    const assistantSummary = summarizeAssistantMessage(assistant);
    const elapsedMs = Date.now() - startedAt;
    diagnostics.pollingAttempts += 1;
    diagnostics.pollingElapsedMs = elapsedMs;
    diagnostics.pollSnapshots.push({
      elapsedMs,
      messageCount: messages.length,
      assistantSummary
    });

    if (
      assistantSummary.found &&
      diagnostics.firstAssistantObservedAt === null
    ) {
      diagnostics.firstAssistantObservedAt = elapsedMs;
    }

    const comparable = JSON.stringify(assistantSummary);
    if (previousComparable !== null) {
      if (comparable === previousComparable) stableConsecutiveCount += 1;
      else {
        diagnostics.assistantChangedDuringPolling = true;
        stableConsecutiveCount = 0;
      }
    }
    previousComparable = comparable;

    if (assistantSummary.found && hasExplicitTerminalState(assistant)) {
      diagnostics.completionCriterion = "explicit_terminal_state";
      break;
    }
    if (
      assistantSummary.found &&
      diagnostics.pollingAttempts >= 2 &&
      stableConsecutiveCount >= 1
    ) {
      diagnostics.completionCriterion = "stable_assistant_summary";
      break;
    }
    if (elapsedMs >= PERSISTENCE_OBSERVATION_WINDOW_MS) {
      diagnostics.completionCriterion = "observation_window_elapsed";
      break;
    }

    const remainingMs = PERSISTENCE_OBSERVATION_WINDOW_MS - elapsedMs;
    await delay(
      Math.min(PERSISTENCE_POLL_INTERVAL_MS, Math.max(0, remainingMs))
    );
  }

  if (diagnostics.completionCriterion === "not_observed") {
    diagnostics.completionCriterion = "max_poll_snapshots";
  }
  diagnostics.pollingElapsedMs = Date.now() - startedAt;
  diagnostics.finalAnswerExtractedAt = new Date().toISOString();
  return { messages, diagnostics };
}

function summarizeAssistantMessage(message) {
  const found = Boolean(message && message.role === "assistant");
  const parts = found && Array.isArray(message.parts) ? message.parts : [];
  const partTypes = parts.map((part) =>
    typeof part?.type === "string" ? part.type : "unknown"
  );
  const partTypeCounts = Object.create(null);
  const textPartLengths = [];
  const textPartStates = [];
  let totalTextLength = 0;
  let combinedText = "";
  let reasoningPartCount = 0;
  let toolPartCount = 0;
  let otherPartCount = 0;

  for (const [index, part] of parts.entries()) {
    const type = partTypes[index];
    partTypeCounts[type] = (partTypeCounts[type] ?? 0) + 1;
    if (type === "text") {
      const length = typeof part?.text === "string" ? part.text.length : 0;
      textPartLengths.push(length);
      textPartStates.push(typeof part?.state === "string" ? part.state : null);
      totalTextLength += length;
      combinedText += `${combinedText === "" ? "" : "\n"}${
        typeof part?.text === "string" ? part.text : ""
      }`;
    } else if (type === "reasoning" || type.startsWith("reasoning-")) {
      reasoningPartCount += 1;
    } else if (isToolPartType(type)) {
      toolPartCount += 1;
    } else {
      otherPartCount += 1;
    }
  }

  return {
    found,
    id: found && typeof message.id === "string" ? message.id : null,
    role: found ? message.role : null,
    partCount: parts.length,
    partTypes,
    partTypeCounts,
    textPartCount: textPartLengths.length,
    textPartLengths,
    totalTextLength,
    trimmedCombinedTextLength: combinedText.trim().length,
    textPartStates,
    reasoningPartCount,
    toolPartCount,
    otherPartCount,
    finishReason: extractFinishReason(message)
  };
}

function isToolPartType(type) {
  return type === "dynamic-tool" || type.startsWith("tool-");
}

function extractFinishReason(message) {
  const finishReason = message?.metadata?.finishReason;
  return typeof finishReason === "string" ? finishReason : null;
}

function hasExplicitTerminalState(message) {
  if (extractFinishReason(message) !== null) return true;
  if (!message || !Array.isArray(message.parts)) return false;
  const statefulParts = message.parts.filter(
    (part) => typeof part?.state === "string"
  );
  if (statefulParts.length === 0) return false;
  const terminalStates = new Set([
    "done",
    "output-available",
    "output-error",
    "approval-denied"
  ]);
  return statefulParts.every((part) => terminalStates.has(part.state));
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function findAssistantMessageForUser(messages, userMessageId) {
  if (!userMessageId) return null;

  const userIndex = messages.findIndex(
    (message) => message?.id === userMessageId
  );
  if (userIndex === -1) return null;

  for (let index = messages.length - 1; index > userIndex; index -= 1) {
    if (messages[index]?.role === "assistant") return messages[index];
  }

  return null;
}

function extractToolCalls(message) {
  if (!message || !Array.isArray(message.parts)) return [];
  return message.parts.filter(isToolUIPart).map((part) => {
    const output = part.output ?? null;
    return {
      toolCallId: part.toolCallId ?? null,
      toolName: getToolName(part),
      state: part.state ?? null,
      input: part.input ?? null,
      output,
      error: part.error ?? part.errorText ?? null,
      proposedQuery: output?.proposedQuery ?? null,
      executedQuery: output?.executedQuery ?? null,
      queryGuard: output?.queryGuard ?? null
    };
  });
}

function extractFinalAnswer(message) {
  if (!message || !Array.isArray(message.parts)) return "";
  return message.parts
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

async function runSelfTests() {
  const secretText = "fixture-visible-secret";
  const secretReasoning = "fixture-reasoning-secret";
  const stepOnly = {
    id: "assistant-step",
    role: "assistant",
    parts: [{ type: "step-start" }]
  };
  const emptyText = {
    id: "assistant-empty",
    role: "assistant",
    parts: [{ type: "text", text: "", state: "streaming" }]
  };
  const nonEmptyText = {
    id: "assistant-text",
    role: "assistant",
    parts: [{ type: "text", text: secretText, state: "done" }],
    metadata: { finishReason: "stop", providerMetadata: { forbidden: true } }
  };
  const reasoningOnly = {
    id: "assistant-reasoning",
    role: "assistant",
    parts: [{ type: "reasoning", text: secretReasoning }]
  };

  assertSelfTest(extractFinalAnswer(stepOnly) === "", "step-start only");
  assertSelfTest(extractFinalAnswer(emptyText) === "", "empty text part");
  assertSelfTest(
    extractFinalAnswer(nonEmptyText) === secretText,
    "non-empty text part"
  );
  assertSelfTest(
    extractFinalAnswer(reasoningOnly) === "",
    "reasoning is not final answer"
  );

  const emptySummary = summarizeAssistantMessage(emptyText);
  const nonEmptySummary = summarizeAssistantMessage(nonEmptyText);
  assertSelfTest(
    JSON.stringify(emptySummary) !== JSON.stringify(nonEmptySummary),
    "polling summaries detect empty-to-non-empty change"
  );
  const serializedDiagnostics = JSON.stringify({
    assistantSummary: nonEmptySummary,
    reasoningSummary: summarizeAssistantMessage(reasoningOnly),
    pollSnapshots: [
      { elapsedMs: 0, assistantSummary: emptySummary },
      { elapsedMs: 200, assistantSummary: nonEmptySummary }
    ]
  });
  assertSelfTest(
    !serializedDiagnostics.includes(secretText) &&
      !serializedDiagnostics.includes(secretReasoning) &&
      !serializedDiagnostics.includes("providerMetadata"),
    "diagnostics omit text, reasoning, and provider metadata payloads"
  );

  const uiDiagnostics = createStreamDiagnostics();
  inspectUiBody(
    'data: {"type":"start-step"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\ndata: [DONE]',
    uiDiagnostics
  );
  assertSelfTest(
    uiDiagnostics.uiChunkTypeCounts["start-step"] === 1 &&
      uiDiagnostics.uiFinishSeen &&
      uiDiagnostics.uiFinishReason === "stop",
    "SSE UI chunks"
  );
  inspectUiBody("malformed fixture body", uiDiagnostics);
  assertSelfTest(
    uiDiagnostics.malformedFrameCount === 1,
    "malformed UI diagnostics"
  );

  const fakeAgent = new EventTarget();
  fakeAgent.send = () => {
    queueMicrotask(() => {
      fakeAgent.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "cf_agent_use_chat_response",
            id: "fixture-request",
            body: "malformed diagnostic body",
            error: true
          })
        })
      );
    });
  };
  let transportError = null;
  try {
    await waitForTurn(fakeAgent, "fixture-request", [], 1000);
  } catch (error) {
    transportError = messageOf(error);
  }
  assertSelfTest(
    transportError === "malformed diagnostic body",
    "malformed diagnostics preserve transport error"
  );

  const oldRaw = JSON.parse(
    await readFile(
      new URL(
        "../runs_raw/2026-08-19T05-47-25-841Z_REL-015.json",
        import.meta.url
      ),
      "utf8"
    )
  );
  assertSelfTest(
    oldRaw.diagnostics === undefined,
    "old raw has no diagnostics"
  );
  const oldCase = cases.find((item) => item.id === oldRaw.caseId);
  assertSelfTest(
    evaluateRun(oldCase, oldRaw).verdict === "FAIL",
    "old raw evaluates"
  );

  console.log("Reliability runner self-test 通过；未建立网络连接。 ");
}

function assertSelfTest(condition, label) {
  if (!condition) throw new Error(`Self-test failed: ${label}`);
}

function evaluateRun(testCase, run) {
  const toolCalls = Array.isArray(run.toolCalls) ? run.toolCalls : [];
  const errors = Array.isArray(run.errors) ? run.errors : [];
  const finalAnswer = run.finalAnswer;
  const toolErrors = collectToolErrors(toolCalls);
  const assertionResults = buildAssertions(
    testCase,
    toolCalls,
    finalAnswer,
    errors,
    toolErrors
  );
  const hardFailures = assertionResults.filter(
    (item) => item.hard === true && item.passed === false
  );
  const manualReview = assertionResults.find(
    (item) => item.assertion === "manual_behavior_review"
  );
  const verdict =
    hardFailures.length > 0 || manualReview?.status === "REVIEWED_FAIL"
      ? "FAIL"
      : manualReview?.status === "REVIEW_REQUIRED"
        ? "PASS_WITH_NOTE"
        : "PASS";

  return { toolErrors, assertionResults, hardFailures, verdict };
}

function collectToolErrors(toolCalls) {
  const toolErrors = [];
  for (const [index, call] of toolCalls.entries()) {
    const name = call.toolName ?? `tool-${index + 1}`;
    if (call.state !== "output-available") {
      toolErrors.push({
        toolName: name,
        type: "invalid_state",
        message: `Tool state is ${String(call.state)}, expected output-available`
      });
    }
    if (isEmptyOutput(call.output)) {
      toolErrors.push({
        toolName: name,
        type: "empty_output",
        message: "Tool output is empty"
      });
    }
    const explicitError =
      call.error ?? call.errorText ?? call.output?.error ?? null;
    if (explicitError || call.output?.success === false) {
      toolErrors.push({
        toolName: name,
        type: "tool_error",
        message: explicitError
          ? String(explicitError)
          : "Tool reported success=false"
      });
    }
  }
  return toolErrors;
}

function isEmptyOutput(output) {
  if (output === null || output === undefined) return true;
  if (typeof output === "string") return output.trim() === "";
  if (Array.isArray(output)) return output.length === 0;
  if (typeof output === "object") return Object.keys(output).length === 0;
  return false;
}

function buildAssertions(testCase, toolCalls, finalAnswer, errors, toolErrors) {
  const answerText = typeof finalAnswer === "string" ? finalAnswer : "";
  const forbiddenTokens = [
    ...new Set([
      ...defaultForbiddenOutputPatterns,
      ...(testCase.forbiddenOutputPatterns ?? [])
    ])
  ];
  const lowerAnswer = answerText.toLowerCase();
  const assertions = [
    {
      assertion: "final_answer_non_empty",
      hard: true,
      passed: typeof finalAnswer === "string" && finalAnswer.trim().length > 0,
      expected: "non-empty trimmed user-visible final answer",
      actualType: typeof finalAnswer,
      actualLength: typeof finalAnswer === "string" ? finalAnswer.length : null,
      trimmedLength:
        typeof finalAnswer === "string" ? finalAnswer.trim().length : null
    },
    {
      assertion: "runner_completed_without_error",
      hard: true,
      passed: errors.length === 0,
      actual: errors.length === 0 ? "no errors" : errors
    },
    {
      assertion: "tool_call_count",
      hard: true,
      passed: toolCalls.length === testCase.expectedToolCalls,
      expected: testCase.expectedToolCalls,
      actual: toolCalls.length
    },
    {
      assertion: "pubmed_routing",
      hard: true,
      passed: testCase.requiresPubMed
        ? toolCalls.some((item) => item.toolName === "searchPubMed")
        : toolCalls.every((item) => item.toolName !== "searchPubMed"),
      expected: testCase.requiresPubMed,
      actual: toolCalls.map((item) => item.toolName)
    },
    {
      assertion: "tool_state",
      hard: true,
      passed: toolCalls.every(
        (item) =>
          item.state === (testCase.expectedToolState ?? "output-available")
      ),
      expected: testCase.expectedToolState ?? "output-available",
      actual: toolCalls.map((item) => item.state)
    },
    {
      assertion: "tool_output_required",
      hard: true,
      passed: toolCalls.every((item) => !isEmptyOutput(item.output)),
      expected: testCase.requireToolOutput ?? toolCalls.length > 0,
      actual: toolCalls.map((item) => !isEmptyOutput(item.output))
    },
    {
      assertion: "tool_errors",
      hard: true,
      passed: toolErrors.length === 0,
      actual: toolErrors
    },
    {
      assertion: "forbidden_output_patterns",
      hard: true,
      passed: forbiddenTokens.every(
        (token) => !lowerAnswer.includes(token.toLowerCase())
      ),
      forbidden: forbiddenTokens,
      actualMatches: forbiddenTokens.filter((token) =>
        lowerAnswer.includes(token.toLowerCase())
      )
    },
    buildPmidCitationGroundingAssertion(toolCalls, answerText)
  ];

  for (const group of testCase.requiredOutputGroups ?? []) {
    const actualMatch = group.anyOf.find((text) =>
      lowerAnswer.includes(text.toLowerCase())
    );
    assertions.push({
      assertion: "required_output_group",
      hard: true,
      groupName: group.name,
      expectedAnyOf: group.anyOf,
      actualMatch: actualMatch ?? null,
      passed: actualMatch !== undefined
    });
  }

  if (testCase.expectedToolName) {
    assertions.push({
      assertion: "tool_name",
      hard: true,
      passed: toolCalls.every(
        (item) => item.toolName === testCase.expectedToolName
      ),
      expected: testCase.expectedToolName,
      actual: toolCalls.map((item) => item.toolName)
    });
  }

  if (testCase.expectedExecutedQuery) {
    const actualQueries = toolCalls.map((item) => item.executedQuery);
    assertions.push({
      assertion: "executed_query",
      hard: true,
      passed: actualQueries.some((query) =>
        equivalentExactPmidQuery(query, testCase.expectedExecutedQuery)
      ),
      expected: testCase.expectedExecutedQuery,
      acceptedForms: [
        testCase.expectedExecutedQuery,
        `${testCase.expectedExecutedQuery}[UID]`,
        `${testCase.expectedExecutedQuery}[PMID]`
      ],
      actual: actualQueries
    });
  }

  if (Array.isArray(testCase.expectedRecordPmids)) {
    const actualPmids = toolCalls.flatMap((item) =>
      Array.isArray(item.output?.records)
        ? item.output.records.map((record) => String(record?.pmid ?? ""))
        : []
    );
    assertions.push({
      assertion: "expected_record_pmid",
      hard: true,
      passed: testCase.expectedRecordPmids.every((pmid) =>
        actualPmids.includes(String(pmid))
      ),
      expected: testCase.expectedRecordPmids,
      actual: actualPmids
    });
  }

  assertions.push({
    assertion: "manual_behavior_review",
    hard: false,
    status: testCase.manualReviewRequired ? "REVIEW_REQUIRED" : "NOT_REQUIRED",
    expectedBehaviors: testCase.expectedBehaviors,
    forbiddenBehaviors: testCase.forbiddenBehaviors
  });

  return assertions;
}

function buildPmidCitationGroundingAssertion(toolCalls, finalAnswer) {
  const citedPmids = stableUnique(
    [
      ...finalAnswer.matchAll(
        /\bpmid\b[*_]*\s*:?\s*[*_]*\s*([1-9]\d{4,7})(?!\d)/gi
      )
    ].map((match) => match[1])
  );
  const availableToolPmids = stableUnique(
    toolCalls
      .filter(
        (call) =>
          call.toolName === "searchPubMed" &&
          call.state === "output-available" &&
          !call.error &&
          !call.errorText &&
          !call.output?.error &&
          call.output?.success !== false
      )
      .flatMap((call) =>
        Array.isArray(call.output?.records)
          ? call.output.records.map((record) => String(record?.pmid ?? ""))
          : []
      )
      .filter((pmid) => /^[1-9]\d{4,7}$/.test(pmid))
  );
  const availableSet = new Set(availableToolPmids);
  const unsupportedPmids = citedPmids.filter((pmid) => !availableSet.has(pmid));

  return {
    assertion: "pmid_citation_grounding",
    hard: true,
    passed: unsupportedPmids.length === 0,
    citedPmids,
    availableToolPmids,
    unsupportedPmids
  };
}

function stableUnique(values) {
  return [...new Set(values)];
}

function equivalentExactPmidQuery(actual, expected) {
  if (typeof actual !== "string") return false;
  const compact = actual.replace(/\s+/g, "").toUpperCase();
  const expectedPmid = String(expected).trim();
  return (
    compact === expectedPmid ||
    compact === `${expectedPmid}[UID]` ||
    compact === `${expectedPmid}[PMID]`
  );
}

function withTimeout(promise, timeoutMs, text) {
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(text)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

function git(argv) {
  try {
    return execFileSync("git", argv, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "unknown";
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
