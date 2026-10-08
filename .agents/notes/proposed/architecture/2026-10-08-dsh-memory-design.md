# Agent Note: dsh-memory 的设计与落地边界

Status: proposed

## Problem

现有长期记忆由三块拼成：远端自托管 mem0（`http://47.122.106.44:8888`，user_id `qianmang`，586 条）、一个 Python MCP 桥（`~/.dsh/mcp/mem0/mem0_mcp.py` + venv，20 个工具）、以及写在 `~/.dsh/AGENTS.md` 与 `dsh-memory` 技能里的写入规则。

三块都要手工维护：MCP 条目由插件管理器写进 profile 的 patch；规则靠提示词生效；凭据 `MEM0_API_KEY` 明文放在 `cordis.patch.yml` 的 `env` 里。2026-10-06 的体检报告暴露了后果——库是 2026-09-28 单日批量导入的产物（569/586 条），107 条冗余，54 组类型标签互斥，`supersede` 从未被使用过。

## Proposal

一个 bundle 包 `dsh-memory` 承载全部三块：host 侧 `memory-core`（TS 直连 mem0 REST、工具面、SessionStart 召回、Stop 候审、技能注册）与 client 侧 `memory-tab`（侧边栏待审页）。凭据经 `ctx.credentials.resolve()` 读取，配置里不出现 key。写入永不自动落库——批准后才调 mem0。

### mem0 REST 契约（2026-10-08 实测）

- 鉴权用 `X-API-Key`；`Authorization: Token <key>` 实测 401。
- `GET /memories?user_id&run_id&agent_id&top_k&show_expired` → 顶层 `{results:[…]}`；每条含 `id / memory / hash / metadata / created_at / updated_at / expiration_date / user_id / attributed_to`。
- `POST /memories`（`MemoryCreate`，必填 `messages`）另有 `user_id / metadata / expiration_date / infer / memory_type / prompt`。
- `POST /search`（`SearchRequest`，必填 `query`）另有 `filters / top_k / threshold / explain / show_expired`。
- `PUT /memories/{memory_id}`（`MemoryUpdate`）为 `text / metadata / expiration_date`，直写不经抽取。
- 服务端每条已带 `hash` 字段：去重键与服务端同语义，不自造算法。
- `infer: false` 关闭 LLM 事实抽取，用于保真写入。

### 候审队列

- 位置 `$DSH_HOME/memory-pending/`；`pending.jsonl` 是唯一事实源，`pending.md` 由它派生（每次变更重写，不手工编辑）。
- 条目字段：`id, hash, text, metadata{category,scope,importance,project,tags}, evidence, source_session, confidence, supersedes, created_at, status(pending|approved|dismissed|expired), decided_at, decided_by, stored_memory_id`。
- `confidence` 由 Stop 启发式打分产生（陈述句且有明确主语/动词判高；疑问句、寒暄、无信息判低），低于阈值不入队；`ctx.llm` 可用时再跑一次抽取提升质量。
- `supersedes` 的消费方是审批流：判重命中已有记忆时填入旧 id。
- TTL 默认 7 天，到期转 `expired` 并移入 `archive.jsonl`，队列不无限增长。

### 审批流（入口：侧边栏 Tab）

- client 插件经 `ctx.betterSidebar.registerTab` 注册「记忆待审」页，读 host route，approve / dismiss 回写。
- approve：先 `POST /search` 判重（按 `threshold`）→ 无命中则 `POST /memories` 带 `infer:false` 与 metadata（保真写入）；命中则 `PUT /memories/{id}` 做取代，并回填 `stored_memory_id` 与 `supersedes`。
- dismiss：`status=dismissed` 留在 jsonl，不再询问。
- expire：超过 TTL 自动置 `expired` 并归档。
- host 侧另提供 `memory_review` 工具作为无 UI 兜底（Tab 依赖第三方插件，未装时审批仍可进行）。

### 自动召回

- SessionStart：注入按 category 分组的 brief，预算 1200 字符。
- UserPromptSubmit：用本轮 prompt 走 `POST /search` 取 top-3，预算 600 字符。
- 任一环节失败 fail-open（只记日志，不阻断会话）。

### 工具面与迁移

- 插件工具：`memory_store / search / get / supersede / brief / list`，加 `memory_review`。
- 迁移方式是**一步切换**：插件完整可用（含 Tab 审批）后从 profile 移除 `mcp-mem0`。
- 切换前必须跑一次一致性核对：同一 `query` 下插件工具与 MCP 工具返回同一结果集。

### 交付与安装

- 本包既是 host bundle 又带 client Tab：`package.json` 需要 `dsh.bundle.patch`（host 侧装配）与 `dsh.client`（客户端清单：`inject` 与 `platform`），Tab 才会随包渲染。
- 安装由 profile 的依赖与 `dsh.profile.bundles` 列表共同决定，GUI 与 CLI 是两条不同入口：
  - `desktop` profile（Electron 宿主）只能经 GUI 的插件入口安装——CLI 明确拒绝：实测 `dsh plugin --profile desktop list` 返回 `error: profile "desktop" is managed exclusively by the Electron application`。
  - 非 Electron profile（如 `web`）：`cd ~/.dsh && dsh plugin --profile web add <spec>`；该命令实测是 pnpm 的包装（`--help` 直接转发 pnpm 11.7.0）。
- GUI 的插件管理器内部同样跑 pnpm：`.plugin-manager/logs/operation-*/pnpm.log` 可见 `+ dsh-native-hooks github:qianmang1/dsh-native-hooks` 与 `Done in 5s using pnpm v11.7.0`。它会规范化依赖串——手工写入的 `github:…#v0.3.0` 会被改写回不带 tag 的形式。

## Alternatives considered

### Why not 继续用 Python MCP 桥？

它现在能用，但它是分发与凭据问题的根源：插件要依赖目标机具备 Python 与 venv，凭据只能经 env 传递（这正是当前明文 key 的成因）。TS 直连同时消掉这两点。

### Why not Stop 时直接自动写入？

库被批量导入污染过一次（107 条冗余），自动写入没有人工闸门会重复同一条路径。候审队列保留自动化收益、去掉污染风险。

### Why not 用 DSH 官方的 side card API？

`packages/` 里没有 `sideCard` / `side-card` 实现（grep 零命中）。侧边栏扩展的实际入口是 `dsh-better-sidebar` 暴露的 `ctx.betterSidebar`，其 README 明确把它开放给所有插件，且 GUI 设置页有「添加 Tab 插件」入口。

### Why not 一个 apply 干完（单 entry）？

工具面、client Tab、技能三者的生命周期不同（Tab 依赖可选插件，技能是纯注册），单 entry 无法分别禁用；一个包 + 独立 entry 的形态保住可关性。

### Why not 先并存、再分阶段淘汰 MCP？

两套工具的写入语义不同：MCP 的 `memory_store` 走 LLM 抽取，插件走 `infer:false` 保真写入。并存期间模型会在两套之间混用，写入语义不一致，且"用哪套"取决于提示词而非机制。一步切换的代价是插件必须先做完整，换来的是全程只有一套语义。

## Acceptance criteria

- `npm run typecheck && npm test` 通过；`node scripts/check.mjs` 通过。
- 一致性核对：同一 `query` 下 `memory_search` 与 MCP `memory_search` 返回同一结果集（切换前执行）。
- 队列：Stop 后条目入队；同 `hash` 不重复；approve 后 mem0 可查到且 `stored_memory_id` 回填；dismiss 后不再出现；TTL 到期条目进 `archive.jsonl`。
- 召回：SessionStart 注入 ≤1200 字符；UserPromptSubmit 注入 ≤600 字符；两处失败都不阻断会话。
- 侧边栏「记忆待审」页可 approve / dismiss，操作后队列文件与 mem0 同步更新。
- 移除 `mcp-mem0` 条目后功能不缺失；`cordis.patch.yml` 中不再出现明文 key。
- 安装路径可达：经 GUI 插件入口装入 desktop profile 后 Tab 出现在侧边栏；经 CLI 装入 web profile 后 host 侧能力可用。

## Risks

- **一步切换的能力真空**：切换后若某个插件工具缺失或出错，没有 MCP 兜底。缓解：切换前逐工具核对一致性；回滚方式是把 `mcp-mem0` 条目加回 profile patch 并重启。
- **审批入口依赖第三方插件**：`dsh-better-sidebar` 的 `ctx.betterSidebar` 契约随版本变化，变更会打断 Tab。缓解：host 侧保留 `memory_review` 工具，审批不因 UI 缺失而不可用。
- mem0 REST 契约已在 2026-10-08 实测（端点、鉴权头、响应结构、`infer` 开关），但 `threshold` 的合适取值尚未标定，需在一致性核对时确定。
- `Stop` 钩子内 `ctx.llm` 是否可用未验证；不可用时退回启发式打分，候选质量下降。
- 迁移期两套工具并存的时间窗虽然短，仍需对齐命名，避免模型混用。
- CLI 与宿主版本不一致：npm 全局 `dsh` 为 `0.1.7-rc.2`，而 GUI 宿主满足 `dsh-better-sidebar@0.24.1` 的 `≥0.2.0-rc.1` 下限。CLI 的版本不能用来判断宿主能力，也不要用它去操作 desktop profile（会被拒绝）。
