# Agent Note: dsh-memory 的设计与落地边界

Status: proposed

## Problem

现有长期记忆由三块拼成：远端自托管 mem0（`http://47.122.106.44:8888`，user_id `qianmang`，586 条）、一个 Python MCP 桥（`~/.dsh/mcp/mem0/mem0_mcp.py` + venv，20 个工具）、以及写在 `~/.dsh/AGENTS.md` 与 `dsh-memory` 技能里的写入规则。

三块都要手工维护：MCP 条目由插件管理器写进 profile 的 patch；规则靠提示词生效；凭据 `MEM0_API_KEY` 明文放在 `cordis.patch.yml` 的 `env` 里。2026-10-06 的体检报告暴露了后果——库是 2026-09-28 单日批量导入的产物（569/586 条），107 条冗余，54 组类型标签互斥，`supersede` 从未被使用过。

## Proposal

一个 bundle 包 `dsh-memory` 承载全部三块：

- host 侧 `memory-core`：TS 直连 mem0 REST（甩掉 Python 与 venv）、注册工具面、SessionStart 自动召回、Stop 写候审队列、注册记忆技能。
- 凭据经 `ctx.credentials.resolve()` 读取（`MEM0_API_KEY` / `MEM0_BASE_URL` / `MEM0_USER_ID`）；配置里不出现 key。
- 候审队列是文件：`$DSH_HOME/memory-pending/pending.jsonl`（事实源）+ `pending.md`（视图）；每条带归一化文本 hash 去重、TTL 7 天、`pending|approved|dismissed|expired` 状态。
- 写入永不自动落库：批准后才调 mem0。
- 呈现层第二步：client 插件经 `ctx.betterSidebar.registerTab` 注册「记忆待审」Tab；`dsh-better-sidebar` 作为可选依赖，未安装时降级为纯 host 能力。

## Alternatives considered

### Why not 继续用 Python MCP 桥？

它现在能用，但它是分发与凭据问题的根源：插件要依赖目标机具备 Python 与 venv，凭据只能经 env 传递（这正是当前明文 key 的成因）。TS 直连同时消掉这两点。

### Why not Stop 时直接自动写入？

库被批量导入污染过一次（107 条冗余），自动写入没有人工闸门会重复同一条路径。候审队列保留自动化收益、去掉污染风险。

### Why not 用 DSH 官方的 side card API？

`packages/` 里没有 `sideCard` / `side-card` 实现（grep 零命中）。侧边栏扩展的实际入口是 `dsh-better-sidebar` 暴露的 `ctx.betterSidebar`，其 README 明确把它开放给所有插件，且 GUI 设置页有「添加 Tab 插件」入口。

### Why not 一个 apply 干完（单 entry）？

工具面、client Tab、技能三者的生命周期不同（Tab 依赖可选插件，技能是纯注册），单 entry 无法分别禁用；一个包 + 独立 entry 的形态保住可关性。

## Acceptance criteria

- `npm run typecheck && npm test` 通过；`node scripts/check.mjs` 通过。
- 装入 profile 后工具面能读到同一份 mem0 数据，结果与现有 20 个 MCP 工具一致。
- SessionStart 注入记忆摘要；Stop 后 `pending.jsonl` 增加条目，且 hash 重复时不新增。
- 批准流程落库并在 `pending.jsonl` 记 `approved_at`。
- 移除 `mcp-mem0` 条目后功能不缺失；`cordis.patch.yml` 中不再出现明文 key。

## Risks

- mem0 REST 契约尚未在插件侧验证（目前只验证到 MCP 层）——第一步先做只读侦察。
- `Stop` 钩子内能否用 `ctx.llm` 做事实抽取未验证；不可用时退回启发式，抽取质量下降。
- `dsh-better-sidebar` 是第三方插件，其 `ctx.betterSidebar` 契约随版本变化。
- 迁移期两套工具并存（`mcp__mem0__*` 与新插件工具），需要对齐命名与语义，避免模型混用。
