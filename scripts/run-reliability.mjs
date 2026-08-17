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

  await waitForTurn(client, requestId, messages, args.timeoutMs);
  finalMessages = await getMessages(normalizedBaseUrl, agentName);
} catch (error) {
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
    evaluateRunPath: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") {
      result.dryRun = true;
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
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Agent turn 在 ${timeoutMs}ms 内未完成`));
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
      if (data.error) {
        cleanup();
        reject(new Error(data.body || "Agent stream error"));
      } else if (data.done) {
        cleanup();
        resolve();
      }
    };

    const onClose = () => {
      cleanup();
      reject(new Error("Agent WebSocket 在 turn 完成前关闭"));
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

async function getMessages(base, agentName) {
  const response = await fetch(
    `${base}/agents/chat-agent/${encodeURIComponent(agentName)}/get-messages`
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

function evaluateRun(testCase, run) {
  const toolCalls = Array.isArray(run.toolCalls) ? run.toolCalls : [];
  const errors = Array.isArray(run.errors) ? run.errors : [];
  const finalAnswer =
    typeof run.finalAnswer === "string" ? run.finalAnswer : "";
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
  const forbiddenTokens = testCase.forbiddenOutputPatterns ?? [
    "<tool_call>",
    "tool_call",
    "arg_key",
    "arg_value"
  ];
  const lowerAnswer = finalAnswer.toLowerCase();
  const assertions = [
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
      passed: forbiddenTokens.every((token) => !lowerAnswer.includes(token)),
      forbidden: forbiddenTokens,
      actualMatches: forbiddenTokens.filter((token) =>
        lowerAnswer.includes(token)
      )
    }
  ];

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
