# Reliability Run Format

真实运行命令：

```bash
node scripts/run-reliability.mjs --case REL-001 --base-url http://localhost:5173
```

结构检查命令不会连接 Agent：

```bash
npm run test:reliability
```

## 实际调用路径

Runner 使用已安装的 `agents/client` 中的 `AgentClient`，连接 `ChatAgent` 的 `default` 实例。它与页面使用相同的 WebSocket Agent 路径和 chat request 消息类型，不会调用另一个模型 API。

Runner 发送完整 UI message 列表，等待对应 request ID 的完成事件，然后从同一 Agent 的 `/get-messages` 端点读取持久化消息。Tool 调用和最终回答都从真实 assistant message parts 中提取。

收到匹配 `requestId` 的 `done` 后，Runner 立即执行第一次 `get-messages`，再有界观察同一次 turn 的持久化摘要。polling 不会再次发送 chat request，因此不是模型 retry，也不会以 `finalAnswer` 变成非空作为停止条件。

## 文件位置

每次真实运行保存为：

```text
runs_raw/<timestamp>_<case-id>.json
```

dry-run 不创建 run 文件。

离线重新评估旧 run：

```bash
node scripts/run-reliability.mjs --evaluate-run runs_raw/<run-file>.json
```

离线模式只读取 run 和当前 `cases.json`，不连接服务器、不调用模型或 PubMed，也不修改原始 run。发现 hard failure 时退出码为 1。

## Final answer non-empty assertion

`final_answer_non_empty` 是对所有 case 和所有 run 生效的全局 hard assertion，不需要 case registry 单独启用。仅当 `finalAnswer` 的类型是字符串，且 `finalAnswer.trim().length > 0` 时通过。断言记录 `actualType`、原始 `actualLength` 和 `trimmedLength`；`undefined`、`null`、非字符串、空字符串和纯空白字符串都失败，并使 verdict 为 `FAIL`。

assistant message 存在、`messageCount` 大于零、Tool 已执行或 `errors=[]` 都不能证明存在用户可见最终回答。此 assertion 也只证明回答非空，不能证明回答正确、相关、安全或完整。

评估不会修改或标准化 raw run 中的 `finalAnswer`，也不会写入 fallback 文本。`runs_raw/*.json` 中的原始值永远保持原样。

## PMID citation grounding assertion

`pmid_citation_grounding` 是全局 hard assertion，不需要 case registry 单独启用。结果字段为：

- `citedPmids`：从最终回答中明确带 `PMID` 标签的 5–8 位编号，按出现顺序去重。
- `availableToolPmids`：仅从同一 run 的 `searchPubMed` Tool output `records[].pmid` 读取，按 Tool/record 顺序去重。
- `unsupportedPmids`：`citedPmids` 中不存在于 `availableToolPmids` 的编号。
- `passed`：仅当 `unsupportedPmids` 为空时为 true。

没有 PMID citation 时 assertion 通过。Tool 调用为 0、Tool error 或 records 为空时，任何 PMID citation 都会失败。此 assertion 不使用用户输入、`expectedRecordPmids`、registry 预期、模型生成的标题、外部查询或其他 run 的 records。

Grounding 通过只表示 PMID 出现在本次 Tool records 中，不能单独证明标题与 PMID 对应、DOI 正确、文章支持结论，或摘要/全文内容正确；这些仍需独立自动检查或人工证据审查。

## 字段

- `runId`：时间戳和 Case ID 组成的唯一运行 ID。
- `caseId`：对应 `cases.json` 中的 ID。
- `timestamp`：UTC ISO 时间。
- `gitCommit`：运行时 Git 提交。
- `dirtyWorktree`：运行时工作区是否有未提交内容。
- `baseUrl`：被测页面的根 URL。
- `agent` / `agentName`：实际 Agent 类和实例名。
- `userInput`：原始用户输入。
- `toolCallCount`：assistant message 中的 Tool part 数量。
- `toolCalls`：Tool 名称、input、output、查询审计字段和状态。
- `finalAnswer`：assistant message 中所有文本 part 合并后的最终回答。
- `durationMs`：连接、执行和读取结果的总时间。
- `errors`：连接、协议、Agent 或读取错误。
- `toolErrors`：Tool state、空 output 和 Tool 自报错误的统一列表。
- `verdict`：`FAIL`、`PASS_WITH_NOTE` 或 `PASS`。
- `assertionResults`：自动断言结果和仍需人工检查的行为。
- `diagnostics`：仅未来 live run 可选的 versioned、非敏感完成观察；旧 raw 可以没有此字段。

## Diagnostics v1

`diagnostics` 包含：

- Stream：`responseStatus`、`matchingFrameCount`、`doneFrameCount`、`errorFrameCount`、`malformedFrameCount`、`uiChunkTypeCounts`、`uiFinishSeen`、实际 chunk 明确提供时的 `uiFinishReason`，以及 `requestCompletedAt`。
- Persistence：`pollingAttempts`、`pollingElapsedMs`、`completionCriterion`、`assistantChangedDuringPolling`、`firstAssistantObservedAt`、`finalAnswerExtractedAt` 和 `pollSnapshots`。
- Output source：固定的 `finalAnswerSource: "assistant.text_parts"` 与最后选中 assistant 的 `assistantSummary`。

UI body 按已安装协议优先解析单个 JSON UI chunk；对于 SSE body，只解析每条 `data:` 行并忽略 `[DONE]`。只累计 chunk `type`，不保存 text/reasoning delta。诊断解析失败只增加 `malformedFrameCount`，不会被伪装成模型错误，也不会吞掉既有 error、close 或 timeout。

每个 `assistantSummary` 仅包含 `found`、ID/role、part 数量与有序类型、按类型计数、text part 数量/长度/state、合并文本的原始和 trim 后长度、reasoning/tool/other 数量，以及明确的 `finishReason`。它不包含 text/reasoning 正文、Tool payload、完整 metadata 或 `providerMetadata`。

持久化常量为 200ms poll interval、5000ms 总观察窗口、26 个 snapshot 上限。停止原因：

- `explicit_terminal_state`：assistant metadata 有明确 `finishReason`，或所有带 state 的 part 均为 Runner 认识的 terminal state。
- `stable_assistant_summary`：已找到目标 assistant，完成至少一次额外 GET，且连续两次摘要相同。
- `observation_window_elapsed`：达到 5 秒观察窗口。
- `max_poll_snapshots`：达到快照数量上限。
- `not_observed`：初始化值；live persistence observation 正常结束后会被具体原因替换。

`pollSnapshots` 只保存相对毫秒数、message count 和安全摘要。最终 `finalAnswer` 仍只从最后一次选中 assistant 的 `type === "text"` parts 提取；reasoning 和 Tool output 都不会成为回答。diagnostics 不参与新的 hard verdict，不能证明医学正确性，也不能单独确定 provider 根因。`final_answer_non_empty` 仍是全局 hard assertion。

Transport 成功只代表请求和消息链路完成，不代表 Tool 成功。任何 Tool 不是 `output-available`、output 为空或存在 Tool error，都会导致 hard assertion 失败。

Verdict 规则：

- 任意 hard assertion 失败：`FAIL`。
- hard assertions 全部通过，但人工状态是 `REVIEW_REQUIRED`：`PASS_WITH_NOTE`。
- hard assertions 全部通过且不需要人工复核：`PASS`。
- 人工状态是 `REVIEWED_FAIL`：`FAIL`。

`manual_behavior_review` 使用独立状态：`REVIEW_REQUIRED`、`REVIEWED_PASS`、`REVIEWED_FAIL` 或 `NOT_REQUIRED`，不能伪装成自动 `passed: true`。

## Case 驱动断言

Runner 从 `cases.json` 读取通用机器断言配置，包括：

- `expectedToolCalls`
- `expectedToolName`
- `expectedToolState`
- `requireToolOutput`
- `expectedExecutedQuery`
- `expectedRecordPmids`
- `forbiddenOutputPatterns`
- `requiredOutputGroups`
- `manualReviewRequired`

`forbiddenOutputPatterns` 会追加到全局默认 Tool leakage patterns，不会覆盖默认检查。匹配忽略大小写。

`requiredOutputGroups` 用于定义最终回答必须包含的安全语义。每个 group 都生成一条 `required_output_group` hard assertion；group 内 `anyOf` 任一普通文本片段出现在 `finalAnswer` 中即通过，匹配忽略大小写且不会把 registry 内容作为正则执行。任一 group 未匹配会使 verdict 为 `FAIL`。断言记录 group name、`expectedAnyOf`、`actualMatch` 和 `passed`。

PMID 精确查询允许 `12345678`、`12345678[UID]`、`12345678[PMID]` 等价形式，但不接受混入其他主题词的查询。

## Raw run 不可修改

`runs_raw/*.json` 是当时执行事实的原始记录。规则升级后不得回写旧 run；应使用 `--evaluate-run` 输出当前规则下的新判断，并保留 original verdict 供比较。

## 安全边界

Runner 不读取或保存 `.env`、Token 或 API Key。实际运行会调用当前页面背后的真实 Agent，因此只能在明确允许模型和 PubMed 请求时执行。本里程碑只运行 dry-run。

## Session isolation

Live reliability run 默认不使用生产页面的 `default` Agent 实例。

Runner 会为每次测试生成唯一的 Agent name，避免不同 case 共享：

- 用户消息；
- assistant 回答；
- Tool Call；
- PubMed 检索结果。

新增字段：

- `agentClass`：实际 Agent 类；
- `agentName`：本次独立实例名称；
- `sessionIsolated`：是否由 Runner 自动隔离；
- `initialMessageCount`：发送问题前的消息数量，隔离运行应为 0；
- `messageCount`：运行完成后的消息数量；
- `requestId`：本次 WebSocket 请求 ID；
- `userMessageId`：本次用户消息 ID。

只有明确传入 `--agent-name` 时才会复用指定实例。
