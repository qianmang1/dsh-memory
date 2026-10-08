# Agent Note: dsh-memory 的设计与落地边界

Status: proposed

## Problem

现有长期记忆由三块拼成：远端自托管 mem0（`http://47.122.106.44:8888`，user_id `qianmang`，586 条）、一个 Python MCP 桥（`~/.dsh/mcp/mem0/mem0_mcp.py` + venv，20 个工具）、以及写在 `~/.dsh/AGENTS.md` 与 `dsh-memory` 技能里的写入规则。

三块都要手工维护：MCP 条目由插件管理器写进 profile 的 patch；规则靠提示词生效；凭据 `MEM0_API_KEY` 明文放在 `cordis.patch.yml` 的 `env` 里。2026-10-06 的体检报告暴露了后果——库是 2026-09-28 单日批量导入的产物（569/586 条），107 条冗余，54 组类型标签互斥，`supersede` 从未被使用过。

现有实现还有一个静默缺陷（2026-10-08 实测）：`memory_search` 往 `POST /search` 传的是 `limit`，而契约字段是 `top_k`。服务端忽略 `limit`、固定返回默认 20 条，Python 侧再用 `rows[:limit]` 截断，所以表面正常；一旦叠加 `category` / `scope` 过滤，就变成"在最近 20 条里筛"而不是"该分类的前 N 条"，结果静默变少。

## Proposal

一个 bundle 包 `dsh-memory` 承载全部三块：host 侧 `memory-core`（TS 直连 mem0 REST、工具面、SessionStart 召回、Stop 候审、技能注册）与 client 侧 `memory-tab`（侧边栏待审页）。凭据经 `ctx.credentials.resolve()` 读取，配置里不出现 key。写入永不自动落库——批准后才调 mem0。

### mem0 REST 契约（2026-10-08 实测）

- 鉴权用 `X-API-Key`；`Authorization: Token <key>` 实测 401。
- `GET /memories?user_id&run_id&agent_id&top_k&show_expired` → 顶层 `{results:[…]}`；每条含 `id / memory / hash / metadata / created_at / updated_at / expiration_date / user_id / attributed_to`。
- `POST /memories`（`MemoryCreate`，必填 `messages`）另有 `user_id / metadata / expiration_date / infer / memory_type / prompt`。
- `POST /search`（`SearchRequest`，必填 `query`）另有 `filters / top_k / threshold / explain / show_expired`；`top_k` 生效、`limit` 被忽略（实测 `{"limit":2}` → 20 条，`{"top_k":2}` → 2 条）。
- `PUT /memories/{memory_id}`（`MemoryUpdate`）为 `text / metadata / expiration_date`，直写不经抽取。
- 服务端每条已带 `hash` 字段：去重键与服务端同语义，不自造算法。
- `infer: false` 关闭 LLM 事实抽取，用于保真写入。
- "取代"由数据形状表达，而不是单独端点：旧条 `PUT` 保留展示字段并置 `metadata.status=historical`，新条 `POST` 带 `metadata.supersedes=<旧 id>` 与 `status=current`；检索默认过滤 `historical`（客户端过滤）。

### 工具面（动词派命名）

| 工具 | 参数 | 语义 |
|---|---|---|
| `memory_remember` | `text`, `category?`, `scope?`, `importance?`, `project?`, `tags?`, `infer?`（默认 `false`） | 保真写入；只有显式 `infer:true` 才交给 mem0 抽取 |
| `memory_recall` | `query`, `top_k?`（默认 10）, `category?`, `scope?`, `include_historical?`（默认 false） | `POST /search` 带 `top_k`；`historical` / `category` / `scope` 过滤在客户端复刻现有语义 |
| `memory_read` | `id` | `GET /memories/{id}` |
| `memory_supersede` | `old_id`, `text`, `category?`, `scope?`, `importance?`, `project?`, `source?` | 旧条标 `historical`，新条带 `supersedes` 指针 |
| `memory_brief` | `max_chars?`（默认 1200） | 按 category 分组的画像摘要 |
| `memory_inventory` | `limit?`（默认 50）, `category?`, `status?`, `scope?`, `importance?` | `GET /memories` 盘点 |
| `memory_review` | `action(list\|approve\|dismiss)`, `id?`, `note?` | 候审队列操作（无 UI 兜底） |

### 候审队列

- 位置 `$DSH_HOME/memory-pending/`；`pending.jsonl` 是唯一事实源，`pending.md` 由它派生（不手工编辑）。
- 条目字段：`id, hash, text, metadata{category,scope,importance,project,tags}, evidence, source_session, confidence, supersedes, created_at, status(pending|approved|dismissed|expired), decided_at, decided_by, stored_memory_id`。
- **写入并发**：新条目一律 **append** 一行到 jsonl（多次并发 append 不互相覆盖）；状态变更（approve/dismiss/expire）走"读全量 → 改目标行 → 临时文件 + rename 原子替换"；同进程内变更串行化（Promise 链），跨进程冲突时以最后写入者为准且状态机幂等。
- `pending.md` 每次变更后从 jsonl 全量重生成（同样 tmp + rename），格式：按状态分节（`## 待审` / `## 已批准` / `## 已驳回`），每条一行 `- [<id 前 6 位>] <text>（<category> · <scope> · <importance> · conf <confidence>）`，其下缩进一行证据与时间；id 简码供人工引用。
- TTL 默认 7 天：**每次队列写入后顺带检查**（不设定时器），SessionStart 时再检查一次；到期条目转 `expired` 并移入 `archive.jsonl`。

### 捕获启发式（Stop）

- 每轮最多 **5 条**候选；`confidence ≥ 0.6` 才入队；只收带明确主语与动词的陈述句，疑问句、寒暄、工具输出不入队。
- `confidence` 由可复算的启发式给出（陈述语气、含主语与动词、含稳定事实词、非问题/非寒暄、长度适中各自加权），低分不写队列。
- `ctx.llm` 若可用，作为质量增强再跑一次抽取；不可用时启发式独立成立（不得依赖 LLM 才有候选）。
- 去重：以归一化文本的 hash 与服务端 `hash` 语义对齐；队列内同 hash 已存在（含已批准/已驳回）则不入队。

### 审批流（入口：侧边栏 Tab）

- client 插件经 `ctx.betterSidebar.registerTab` 注册「记忆待审」页，读 host route，approve / dismiss 回写。
- approve：先 `POST /search` 判重（`threshold` 取值在一致性核对时标定）→ 无命中 `POST /memories` 带 `infer:false` 与 metadata（保真写入）；命中则按 mem0 的取代形状执行（旧条 `PUT` 置 `historical`，新条带 `supersedes`），并回填 `stored_memory_id` 与 `supersedes`。
- dismiss：`status=dismissed` 留在 jsonl，不再询问。
- expire：超过 TTL 自动置 `expired` 并归档。
- host 侧 `memory_review` 是同等能力的兜底入口（Tab 依赖第三方插件，未装时审批仍可进行）。

### 自动召回

- SessionStart：注入按 category 分组的 brief，预算 **1200 字符**；组内按 importance（permanent > long_term > temporary）再按 `created_at` 新→旧排序，超出预算即截断。
- UserPromptSubmit：用本轮 prompt 走 `POST /search` 取 **top-3**，仅注入 `score ≥ threshold` 的条目，预算 **600 字符**。
- 任一环节失败 fail-open（只记日志，不阻断会话）。

### 技能

- 只内置**写入规则**一个技能（现 `~/.dsh/skills/dsh-memory` 的内容随包分发，经 `ctx.skills` 注册，名称保持不变）；审计流程继续留在 `~/.dsh/skills` 作为外部流程。

### 测试

- 单元（`node --test`）：Config 解析、hash 去重、启发式打分、md 渲染、append 与状态变更的原子性、工具参数校验。
- 集成：写路径（`memory_remember` / `memory_supersede` / 审批）跑本地 **stub HTTP server**，不碰真库。
- 真 mem0 只跑**只读**测试（`memory_recall` / `memory_inventory` / `memory_brief`），由环境变量开关，默认跳过。
- 不对真库做写入测试；需要时必须是显式开关 + 写完立即删除，不写进常规套件。

### 观测

- 日志前缀统一 `dsh-memory:`；mem0 调用失败按 网络 / 鉴权 / 4xx / 5xx 分类记录，钩子内失败只 warn。

### 交付与安装

- 本包既是 host bundle 又带 client Tab：`package.json` 需要 `dsh.bundle.patch`（host 侧装配）与 `dsh.client`（客户端清单：`inject` 与 `platform`），Tab 才会随包渲染。
- 安装由 profile 的依赖与 `dsh.profile.bundles` 列表共同决定，GUI 与 CLI 是两条不同入口：
  - `desktop` profile（Electron 宿主）只能经 GUI 的插件入口安装——CLI 明确拒绝：实测 `dsh plugin --profile desktop list` 返回 `error: profile "desktop" is managed exclusively by the Electron application`。
  - 非 Electron profile（如 `web`）：`cd ~/.dsh && dsh plugin --profile web add <spec>`；该命令实测是 pnpm 的包装（`--help` 直接转发 pnpm 11.7.0）。
- GUI 的插件管理器内部同样跑 pnpm：`.plugin-manager/logs/operation-*/pnpm.log` 可见 `+ dsh-native-hooks github:qianmang1/dsh-native-hooks` 与 `Done in 5s using pnpm v11.7.0`。它会规范化依赖串——手工写入的 `github:…#v0.3.0` 会被改写回不带 tag 的形式。

### 版本范围与迁移

- **v0.1.0 范围**：host 侧（工具面 + 两个钩子 + 候审队列 + 技能）+ client Tab（审批入口）。
- 迁移（从 profile 移除 `mcp-mem0`）**不随版本自动发生**：v0.1.0 验收通过、且完成一致性核对之后手工执行。

## Alternatives considered

### Why not 继续用 Python MCP 桥？

它现在能用，但它是分发与凭据问题的根源：插件要依赖目标机具备 Python 与 venv，凭据只能经 env 传递（这正是当前明文 key 的成因）。TS 直连同时消掉这两点，并顺手修掉 `limit` / `top_k` 那个静默缺陷。

### Why not Stop 时直接自动写入？

库被批量导入污染过一次（107 条冗余），自动写入没有人工闸门会重复同一条路径。候审队列保留自动化收益、去掉污染风险。

### Why not 用 DSH 官方的 side card API？

`packages/` 里没有 `sideCard` / `side-card` 实现（grep 零命中）。侧边栏扩展的实际入口是 `dsh-better-sidebar` 暴露的 `ctx.betterSidebar`，其 README 明确把它开放给所有插件，且 GUI 设置页有「添加 Tab 插件」入口。

### Why not 一个 apply 干完（单 entry）？

工具面、client Tab、技能三者的生命周期不同（Tab 依赖可选插件，技能是纯注册），单 entry 无法分别禁用；一个包 + 独立 entry 的形态保住可关性。

### Why not 先并存、再分阶段淘汰 MCP？

两套工具的写入语义不同：MCP 的 `memory_store` 走 LLM 抽取，插件走 `infer:false` 保真写入。并存期间模型会在两套之间混用，写入语义不一致，且"用哪套"取决于提示词而非机制。一步切换的代价是插件必须先做完整，换来的是全程只有一套语义。

### Why not 沿用 MCP 的 store/search/get 命名？

现有名字里混着后端词（`memory_list_entities`、`memory_expire`）与一次静默失效的 `limit` 参数；动词派命名（remember / recall / read / supersede / brief / inventory / review）自洽，且替换后不存在"旧名字但新语义"的歧义。

### Why not 队列用单一 markdown 文件当事实源？

人可读性好，但并发写与去重难做对：markdown 没有稳定主键，多会话同时追加会撕裂条目。jsonl 追加 + 派生 md 视图把"机读事实"与"人读视图"分开。

## Acceptance criteria

- `npm run typecheck && npm test` 通过；`node scripts/check.mjs` 通过。
- 一致性核对：同一 `query` 下 `memory_recall` 与 MCP `memory_search` 返回同一结果集（切换前执行）；`top_k` 生效（`top_k=2` 返回 2 条）。
- 队列：Stop 后条目入队且 ≤5 条；`confidence < 0.6` 不入队；同 `hash` 不重复；approve 后 mem0 可查到且 `stored_memory_id` 回填；dismiss 后不再出现；TTL 到期条目进 `archive.jsonl`；`pending.md` 与 jsonl 同步。
- 召回：SessionStart 注入 ≤1200 字符；UserPromptSubmit 注入 ≤600 字符；两处失败都不阻断会话。
- 侧边栏「记忆待审」页可 approve / dismiss，操作后队列文件与 mem0 同步更新。
- 写路径测试全部跑在 stub server 上；真库测试只读且默认跳过。
- 移除 `mcp-mem0` 条目后功能不缺失；`cordis.patch.yml` 中不再出现明文 key。
- 安装路径可达：经 GUI 插件入口装入 desktop profile 后 Tab 出现在侧边栏；经 CLI 装入 web profile 后 host 侧能力可用。

## Risks

- **一步切换的能力真空**：切换后若某个插件工具缺失或出错，没有 MCP 兜底。缓解：切换前逐工具核对一致性；回滚方式是把 `mcp-mem0` 条目加回 profile patch 并重启。
- **审批入口依赖第三方插件**：`dsh-better-sidebar` 的 `ctx.betterSidebar` 契约随版本变化，变更会打断 Tab。缓解：host 侧 `memory_review` 提供同等能力。
- **`threshold` 尚未标定**：判重与召回注入都用它，取值需要在一致性核对阶段用真实数据测定，不能凭感觉写死。
- **`ctx.llm` 可用性未验证**：`Stop` 钩子内能否调用未确认；不可用时退回启发式打分，候选质量下降但功能完整。
- **多会话并发**：新条目 append 是安全的，状态变更走读-改-写，跨进程并发窗口内以最后写入者为准；状态机幂等，但极端并发下可能丢一次状态转换。
- **CLI 与宿主版本不一致**：npm 全局 `dsh` 为 `0.1.7-rc.2`，而 GUI 宿主满足 `dsh-better-sidebar@0.24.1` 的 `≥0.2.0-rc.1` 下限。CLI 版本不能用来判断宿主能力，也不要用它操作 desktop profile。
