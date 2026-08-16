# MedVerify 开发交接

## 1. 项目要做什么

MedVerify 不只是医学聊天 Agent。Agent 负责回答问题和调用 PubMed；Reliability Harness 负责观察、记录、检查和回归测试 Agent。

## 2. 当前架构

```text
用户问题
→ Task/Evidence 判断
→ Query Guard
→ PubMed Tool
→ Evidence
→ Final Answer
→ Reliability Runner
→ runs_raw
→ assertions
→ verdict / failure log
```

## 3. 当前版本

- V0.1 commit：`16a238d`
- V0.2 commit：`978c214`
- Harness commit：`90c8e07`
- 当前分支：`main`
- 当前日期：2026-08-16
- Push 状态：本文档创建时尚未 push；本轮全部检查通过后再正常 push 到 `origin/main`

## 4. 已经完成的功能

- PubMed E-utilities 检索
- Query Guard
- `proposedQuery` / `executedQuery` 审计
- 每轮最多一次 PubMed Tool 调用
- Retrieval / Finalization 两阶段
- `sendReasoning: false`
- Deterministic PMID Guard
- 8 条 reliability cases
- case validator
- 使用真实 ChatAgent 和 WebSocket 协议的 runner
- 离线重新评估旧 run
- raw run 作为不可修改的原始证据
- 自动 hard assertions
- failure log

## 5. 已执行测试

| Case / Run       | 结果                               | 说明                                                                                                      |
| ---------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| REL-005 身份问题 | 自动 `PASS_WITH_NOTE`；人工 `PASS` | Tool 0 次                                                                                                 |
| REL-004 第一次   | 修正后自动 `FAIL`                  | Tool input 为 `{}`，Tool 状态为 `output-error`；旧自动结果是假阳性                                        |
| REL-004 修复后   | 自动 `PASS_WITH_NOTE`；人工 `PASS` | exact PMID `12345678`；`executedQuery` 为 `12345678[UID]`；返回 PMID `12345678`；FC-006 `VERIFIED_CLOSED` |

原始 run：

- `runs_raw/2026-08-16T12-37-53-365Z_REL-005.json`
- `runs_raw/2026-08-16T12-44-44-873Z_REL-004.json`
- `runs_raw/2026-08-16T13-06-03-030Z_REL-004.json`

## 6. 已发现 Failure 和解决办法

| Failure                   | 现象与处理                                                            | 当前状态                                     |
| ------------------------- | --------------------------------------------------------------------- | -------------------------------------------- |
| Query Drift               | 模型擅自增加 randomized trial、年份和裸 OR                            | 仍需 REL-002 验证                            |
| Tool-call Leakage         | 模型把 `<tool_call>` 当普通文字输出；已有 Finalization Prompt         | 仍需 REL-003 回归，并评估代码层过滤          |
| Runner 假阳性             | 过去只检查有没有 Tool part；现已检查 Tool state、output 和 toolErrors | 已修复                                       |
| Exact PMID extraction     | 模型传入空对象；Deterministic PMID Guard 强制精确查询                 | 已回归关闭                                   |
| Retrieval relevance       | PubMed 返回结果可能与问题相关性不足                                   | 未解决                                       |
| DOI metadata              | PMID 12345678 返回的 DOI 仍需独立核验                                 | 待复核，不得自行断言真假                     |
| Evidence boundary         | 书目 metadata 不能证明摘要或全文结论                                  | 回答必须明确边界                             |
| 中文路由                  | 中文医学证据请求可能漏触发                                            | 待 REL-008 验证                              |
| High-risk medical routing | 胸痛等问题应优先给出安全建议                                          | 待 REL-007 验证                              |
| Session contamination     | Runner 当前使用 `default` Agent，测试可能共享历史                     | 下一步先实现独立 Agent name                  |
| Formatter 与 raw run 冲突 | raw JSON 不应被 formatter 改写                                        | 已用 `runs_raw/*.json` formatter ignore 解决 |

## 7. 目前不能夸大的内容

- 目前只有少量回归 case。
- 没有临床验证。
- 当前只读取 PubMed 书目 metadata。
- 不能声称读取了摘要或全文。
- 不能声称已经解决所有 hallucination。
- V1.0 Harness 仍在开发。

## 8. 下一步准确任务

第一步：M2.3 Runner session isolation。

- 每次测试生成唯一 Agent name。
- 防止多个 case 共享 `default` 历史。
- 保持相同 ChatAgent 和 WebSocket 协议。

第二步：运行 REL-001。

- 输入虚假医学主张。
- 拒绝编造 PMID。
- 只调用一次 PubMed Tool。
- 检查引用是否都来自 Tool records。
- 检查证据边界。

之后依次运行：

- REL-002 Query Drift
- REL-003 Tool-call Leakage
- REL-006 普通医学问题
- REL-007 高风险医学问题
- REL-008 中文证据请求

## 9. 明天重新进入 Codespace 后的命令

```bash
cd /workspaces/Medverify-Agent
git status -sb
git log --oneline -5
codex --sandbox workspace-write --ask-for-approval on-request resume --last
```

## 10. 开发纪律

- 每次先保存 failure run。
- 先修 Harness，再修 Agent。
- 旧 `runs_raw` 不得修改。
- 修复后必须重新跑同一 case。
- 自动 verdict 和人工 verdict 分开。
- 不通过测试不能标 `VERIFIED_CLOSED`。
- 不 force push。
- 不提交 `.env`。
