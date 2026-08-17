# Reliability Case Registry

`cases.json` 是 MedVerify Reliability Harness 的可复用测试用例登记表。一条记录只描述一个输入、预期 Tool 行为、允许行为和禁止行为，后续可以持续追加。

## currentStatus 怎么填

- `NOT_RUN`：用例已登记，但还没有运行。
- `PASS`：实际结果满足全部 Pass 要求。
- `FAIL`：至少一个关键要求不满足。
- `PASS_WITH_NOTE`：主要要求通过，但仍有不影响主结论的限制、异常或待复核内容。

状态必须来自实际运行结果。代码已经实现、提示词已经修改，都不能直接写成 `PASS`。

## 自动结果和人工结果

Transport 成功不等于 Tool 成功。Runner 会单独检查 Tool state、output 和 Tool error；任何 hard assertion 失败都必须是 `FAIL`。

自然语言和医学证据边界需要人工复核时，`manual_behavior_review` 状态为 `REVIEW_REQUIRED`，自动 verdict 最多是 `PASS_WITH_NOTE`。人工结果应另记为 `REVIEWED_PASS` 或 `REVIEWED_FAIL`，不能用一个布尔值冒充已经审核。

Case 可以用以下通用字段增加机器断言：

- `expectedToolName`
- `expectedToolState`
- `requireToolOutput`
- `expectedExecutedQuery`
- `expectedRecordPmids`
- `forbiddenOutputPatterns`
- `manualReviewRequired`

## 离线重评旧 Run

```bash
node scripts/run-reliability.mjs --evaluate-run runs_raw/<run-file>.json
```

离线重评使用当前 case 规则，不连接服务器、不调用模型或 PubMed，也不修改原始 `runs_raw` JSON。旧 run 的原始 verdict 会保留在原文件中，新规则的结果只打印到终端。

## 当前校验范围

运行：

```bash
npm run test:cases
```

当前脚本只验证测试数据结构，包括 JSON 是否可读、ID 是否重复、必填字段是否存在，以及 `expectedToolCalls` 是否为 0 或 1。

`test:cases` 只验证 registry 结构；真实 Agent runner 和离线重评由 `scripts/run-reliability.mjs` 提供。医学和自然语言行为仍不能只靠结构校验确认。

## 独立测试会话

实际运行时不要默认传入 `--agent-name`。

Runner 会自动创建独立实例，例如：

```text
reliability-rel-005-20260817023907-13e1a6d4
```
