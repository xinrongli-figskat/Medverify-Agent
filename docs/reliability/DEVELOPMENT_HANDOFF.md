# MedVerify 开发交接 Handbook

> 交接日期：2026-08-19。本文列出的本轮 raw run 文件名使用 UTC 时间戳，所以显示为 2026-08-18；这不代表交接日期写错。

## 1. 项目目标

MedVerify = Medical Agent + Reliability Harness。

- Agent 负责判断任务、选择路径、调用 PubMed、生成回答。
- Harness 负责保存真实 run、自动断言、离线重评、发现回归、管理 Failure Log。

项目仍在做工程可靠性验证，没有完成临床验证，也没有解决所有 hallucination。

## 2. 当前技术架构

```text
用户输入
→ ChatAgent.onChatMessage
→ TypeScript Router
→ emergencyMode / requiresPubMed / extractedPmid
→ streamText
→ prepareStep
→ 普通回答 / Emergency / PubMed Retrieval / PubMed Finalization
→ 最终回答
→ Reliability Runner
→ runs_raw
→ assertions
→ verdict
→ Failure Log
```

`onChatMessage` 先读取本轮用户输入并计算路由状态。`prepareStep` 再按这些状态为每一步设置 Prompt、Tool 权限和状态转换；它不是最初的自然语言分类器。

当前 Agent 没有经过微调。修改 Agent 主要是修改 TypeScript orchestration、Prompt、Tool schema 和 Guard。

## 3. 当前四条执行路径

| 路径                    | 什么时候进入                         | 当前行为                                                                    |
| ----------------------- | ------------------------------------ | --------------------------------------------------------------------------- |
| Emergency non-retrieval | 命中 `isClinicalEmergency`           | Emergency 优先级高于 PubMed；关闭所有 Tool，直接给简短急救指引              |
| Ordinary non-retrieval  | 不紧急，也不需要 PubMed              | Tool 为空，使用普通系统 Prompt 直接回答；不会进入 PubMed retrieval complete |
| PubMed retrieval        | `requiresPubMed = true` 的第 0 步    | 强制只调用一次 `searchPubMed`                                               |
| PubMed finalization     | 已有真实 `searchPubMed` `toolResult` | 关闭 Tool，只用已返回的 PubMed metadata 生成最终回答                        |

PubMed Finalization 不能仅凭路由意图进入，必须确认真实 `searchPubMed` toolResult 已完成。

## 4. “先增强 Harness，再修 Agent”方法

```text
Observe
→ Record
→ Assert
→ Old run must FAIL
→ Fix Agent
→ Rerun same case
→ New run must PASS
→ Manual review
→ Update Failure Log
→ Commit / Push
```

不能先修 Agent：否则无法证明测试真能发现旧错误；模型单次答对也可能只是随机；将来问题复发时，Harness 仍可能给出假阳性 PASS。

## 5. 本次会话完成内容

### M2.5

Commit：`7bd8213 test: add hard output behavior assertions`

- 增加 `requiredOutputGroups`。
- 旧 REL-007 离线重评为 `FAIL`。
- 能自动检测缺少 `do not drive yourself`。

### M2.6

Commits：

- `a47d96a fix: harden emergency and non-retrieval routing`
- `4809828 test: record M2.6 routing regressions`

完成内容：增加 `isClinicalEmergency`；Emergency 强制关闭 PubMed；增加独立 Emergency Prompt；修复普通非检索问题错误进入 PubMed Finalization。REL-006、REL-007 回归通过，FC-007、FC-020 为 `VERIFIED_CLOSED`。

### M2.7A

Commit：`7a1bf19 test: reject unsupported PMCID labels`

- REL-004 增加 PMCID forbidden hard assertion。
- FC-021 原始 run 离线重评为 `FAIL`。
- 旧正常 REL-004 保持 `PASS_WITH_NOTE`。

### M2.7B

Commits：

- `84638b1 fix: preserve PubMed identifier types`
- `95e104b test: record PMID identifier regression`

Finalization Prompt 增加 Identifier Consistency：`pmid` 只能称为 PMID；Tool 没有 `pmcid` 时不得使用 PMCID。新 REL-004 回归通过，FC-021 为 `VERIFIED_CLOSED`；FC-004 DOI 问题仍为 `OPEN`。

## 6. 本轮关键 Run

以下文件名都是 2026-08-18 的 UTC 时间戳，本 Handbook 的交接日期是 2026-08-19。

| 用途            | Raw run                                          |
| --------------- | ------------------------------------------------ |
| REL-007 原失败  | `runs_raw/2026-08-18T13-53-58-537Z_REL-007.json` |
| REL-007 修复后  | `runs_raw/2026-08-18T14-53-37-451Z_REL-007.json` |
| REL-006 修复后  | `runs_raw/2026-08-18T14-56-24-283Z_REL-006.json` |
| FC-021 原始失败 | `runs_raw/2026-08-18T15-03-59-219Z_REL-004.json` |
| 环境失败        | `runs_raw/2026-08-18T15-44-03-246Z_REL-004.json` |
| FC-021 修复后   | `runs_raw/2026-08-18T15-51-06-892Z_REL-004.json` |

环境失败的原因是服务器未启动。该 run 的 `requestId` 为 `null`，没有调用 Agent、模型或 PubMed，不属于产品行为失败。后续运行必须使用 `curl if` 门禁，预检失败就不能继续启动 runner。

## 7. 当前 Emergency Router 的真实能力

当前 TypeScript Emergency Router 只确定性覆盖以下组合：

- `chest pain`；
- 加呼吸困难表达；
- 加本人当前症状线索。

它还不能被描述为覆盖所有急症。尚未确定性覆盖的例子包括：

- stroke signs；
- anaphylaxis；
- severe bleeding；
- unconsciousness / seizure；
- overdose；
- self-harm risk；
- 中文急症表达；
- 未列入词表的同义表达。

当前规则属于高精度、低覆盖率。未命中时可能进入普通模型路径，这是下一阶段的重要风险。

## 8. 当前仍开放的问题

以下状态按当前 `docs/reliability/failure_cases.md` 核对，不在这里复制完整 Failure Log。

| Failure                           | 状态          | 还缺什么                                      |
| --------------------------------- | ------------- | --------------------------------------------- |
| FC-001 Query Drift                | `PARTIAL_FIX` | 历史漂移形式还没有被确定性完整覆盖            |
| FC-003 Retrieval relevance        | `OPEN`        | Retrieval 仍可能返回低相关结果                |
| FC-004 DOI metadata               | `OPEN`        | DOI 仍需独立核验                              |
| FC-008 首页 Starter 内容          | `PARTIAL_FIX` | README 已改，UI 仍待处理                      |
| FC-009 MCP UI 与实际 Tool 不一致  | `OPEN`        | 产品选择和功能测试未完成                      |
| FC-010 timeout / retry / 429      | `OPEN`        | 没有显式超时、有限重试和 429 处理             |
| FC-011 纯中文 Evidence Router     | `OPEN`        | 只验证了包含英文 `PubMed` 的中文输入          |
| FC-012 输出层硬过滤               | `PARTIAL_FIX` | Prompt 和断言已有，用户可见输出层硬过滤未实现 |
| FC-014 PubMed JSON runtime schema | `OPEN`        | 仍依赖 TypeScript 类型断言                    |
| FC-015 metadata 不能证明全文      | `OPEN`        | 当前只有书目 metadata，没有摘要或全文         |
| FC-019 guideline scope            | `OPEN`        | 缺少确定性修复和专门 hard assertion           |

## 9. 明天第一优先任务：M2.8 Emergency Coverage Harness

M2.8 尚未完成。明天先增强 Harness，不立即扩充 Router。

### M2.8A Emergency Case Matrix

先建立正样本：

- stroke warning signs；
- anaphylaxis；
- severe bleeding；
- unconsciousness / seizure。

再建立负样本：

- 普通医学知识问题中提到胸痛；
- 第三人称或假设性症状问题；
- 已经结束的历史症状描述；
- 否定表达。

目的：同时检测 emergency 漏报和误报。

### M2.8B Old Agent Baseline

用现有 Agent 运行新增 case，并保存所有 raw run。预期部分真实急症不会进入 Emergency；这些失败就是后续修复所需的 baseline。

### M2.8C Router 扩展

只有 Harness 已经能判错，才把 `isClinicalEmergency` 重构为可维护规则表：

- symptom family；
- current/personal cue；
- negation；
- hypothetical/educational context；
- English synonyms；
- 后续中文扩展。

### M2.8D Regression

重新运行同一批 case，要求：

- 急症进入 Emergency；
- 普通知识问题不误判；
- Tool 调用 0 次；
- 不假定国家急救号码；
- 不提供药物剂量；
- 必要时明确不要自行驾车。

## 10. 后续任务顺序

1. M2.8 Emergency Coverage
2. FC-004 + FC-014 PubMed metadata integrity/runtime schema
3. FC-010 timeout、429、retry
4. FC-003 Retrieval relevance
5. FC-011 纯中文路由
6. FC-012 输出层硬过滤
7. FC-019 guideline scope

## 11. 明天重新进入 Codespace

```bash
cd /workspaces/Medverify-Agent
git status -sb
git log --oneline -10
npm run check
npm run test:cases
```

如果需要 Codex：

```bash
codex --sandbox workspace-write --ask-for-approval on-request
```

运行 E2E 前必须先启动服务器。

终端 A：

```bash
npm run dev -- --host 127.0.0.1
```

终端 B 必须用 `curl if` 门禁；`curl` 失败后不得继续运行 runner。例如：

```bash
if curl --fail --silent --show-error http://127.0.0.1:5173/ >/dev/null; then
  node scripts/run-reliability.mjs --case REL-007 --base-url http://127.0.0.1:5173
else
  echo "开发服务器不可用；不运行 reliability runner。"
fi
```

## 12. 开发纪律

- 旧 raw run 不得修改。
- 每次使用独立 Agent session。
- 先保存 failure。
- 先增强 Harness。
- 旧 run 必须离线 `FAIL`。
- 再修改 Agent。
- 重新运行同一 case。
- 自动 verdict 和人工 verdict 分开。
- 不通过回归不能 `VERIFIED_CLOSED`。
- 不提交 `.env`。
- 不 force push。
- 临时报告只写 `/tmp`，不提交。
