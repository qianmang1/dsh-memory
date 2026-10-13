# Agent Note: 移除每步召回注入（注入自持循环）

Status: implemented

## Problem

2026-10-11 的真实会话里，用户看到 agent 连续空转：十几条「空闲／待命」式回复之间没有任何真人输入。解压该会话（DESKTOP profile，dsh-memory 0.2.3，`session-ca175f2e-…`）的全部 zstd 帧并按 `seq` 排序后统计：

| 事实 | 数值 |
| --- | --- |
| `turn/start` / `step/start` | 2 / 65 |
| `user/message` 中的召回注入（`相关长期记忆（按相关度排序，仅供参考）`） | **67** |
| 上述注入的文本去重后 | **3** 种 |
| SessionStart brief 注入（`长期记忆摘要…`） | 1 |
| 注入后第一条 `assistant/message`：带工具调用 / 仅文本 | 54 / **13** |
| 相邻注入间隔 最小 / 中位 | 11.3 s / 27.1 s |

注入自持链（每一步都有会话事件可核）：

1. `agent/pre-step` 钩子在**每个 step**执行召回，`query` 取该 step 的全部文本（含上一次注入与模型自己的回复）；
2. 命中结果经 `injectContext` 变成一条**用户角色消息**（`createUserMessage({ source: { kind: 'dsh-memory' } })`），宿主记为 `user/message` 并接 `agent/inbox/spliced(target: next-step)`；
3. 该注入成为下一步的输入；这一步没有真人发言可答，模型只能对记忆本身作答；
4. 这段作答又成为下一个 step 的 `query`（非空）→ 再次召回 → 再次注入 → 循环自持，直到模型自己不再输出。

与设计意图的偏差：`.agents/notes/implemented/architecture/2026-10-08-dsh-memory-design.md` 写的是 **UserPromptSubmit**（每轮用户 prompt 取 top-3、预算 600 字符），实现却挂在 `agent/pre-step`（每 step）。

## Decision

删除整个 per-step 召回注入，不留配置项：

- `src/recall-plugin.ts`：删掉 `agent/pre-step` 钩子、`recall` 配置项与 `RECALL_BUDGET` / `RECALL_TOP_K`；只保留 `agent/created` 的 SessionStart brief（每个 agent 只注入一次，无法自我喂食）。
- `src/recall.ts`：删掉只服务该钩子的 `renderRecallInjection`、`RecallBudgets` 与 `RECALL_HEADER`。
- `cordis.patch.yml` 与 `README.md` 的 `memory-recall` 行去掉 `recall: true`；`locale/recall/{zh,en}.json` 的组件说明改为「会话启动注入分组摘要，不按步注入」。
- 用例同步：`tests/recall.test.ts` 只留 brief 渲染；`tests/config.test.ts` 断言空配置不再产生 `recall` 字段。

需要按当轮问题检索记忆时，显式调用 `memory_recall` 工具——不再由钩子代劳。

## Consequences

- 失去「长工具链中途自动提示相关记忆」这一原设计目标；代价换取的是不再有注入驱动的空转 step。将来若要恢复，必须先解决「注入不得成为下一步的输入」（或至少同文本去重 + 每轮上限），不能只把钩子加回来。
- 会话日志里不再出现 `相关长期记忆` 注入事件，`memory_debug` 的 `hook recall.*` 追踪随之消失，只剩 `brief.*`。
- 每会话仍有一次 `inventory` 请求（brief 未动），组件开关仍存在，只是不再有第二个开关项。

## Alternatives considered

- **`recallMode: 'per-prompt' | 'per-step'`，默认 per-prompt**：能修缺陷且保留中途提示的能力，但要在钩子里判定「本步是否含真实用户消息」（`messages.some(m => m.source.kind === 'user')`）并在 per-step 模式下继续承担自持风险；实现面更大，且用户明确选择直接砍掉。
- **保留每步注入，只加同文本去重 + 每轮上限**：治标——注入仍会驱动 step，只是次数变少；且 3 种文本复用了 67 次，说明去重能压量但不能断链。
- **改宿主 `agent-loop`，让 context-formed 消息不再单独驱动 step**：更根本，但跨仓库、牵动会话语义与快照，超出本插件范围（见下）。
- **只在 profile 配置里关掉 `recall`**：会把未验证的代码路径与死配置留在仓库里，等于用配置掩盖缺陷。

## Residual

宿主侧问题未证：一条 context-formed 的注入消息为什么能推起一个新的 step（而不是仅作为下一步输入存在），本仓库无法验证。若宿主改为「注入不驱动 step」，per-prompt 召回可以安全恢复；在此之前不做。
