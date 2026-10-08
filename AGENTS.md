# dsh-memory Agent 规则

> 通用规则（联网搜索主备降级、输出规范默认极简、交付前自检、搜索结果引用把关）见 ~/.dsh/AGENTS.md，此处不重复。

## 项目定位

DSH（DeepSeek Harness）的长期记忆插件：把自托管 mem0 接进 DSH，提供记忆工具、SessionStart 自动召回、Stop 候审队列，以及侧边栏待审页。

dsh-memory：取代"Python MCP 桥 + 手写 AGENTS.md 规则"的组合，用一个 bundle 承载工具面、技能与钩子。改动前先读 `.agents/notes/` 下的设计决策笔记与 `~/.dsh/skills/dsh-memory/SKILL.md`（记忆写入规则）。

## 布局

- `src/index.ts` — host 入口插件：工具面、钩子、候审队列、技能注册。
- `cordis.patch.yml` — bundle 装配清单；profile 列出本包时插入的条目与默认配置。
- `tests/` — `node --test` 用例。
- `.agents/notes/` — 决策记录（proposed/implemented/rejected/archived × 6 类）。
- `.agents/skills/` — 本项目技能（`memory-` 前缀）。
- `scripts/check.mjs` — 规则骨架自检。
- `lib/` — 构建产物（gitignore；git 安装时由 `prepack` 生成）。

## 命令

```sh
npm install              # 依赖（首次）
npm run typecheck        # tsc -p tsconfig.json
npm test                 # node --test "tests/**/*.test.ts"
npm run build            # tsdown → lib/index.js
node scripts/check.mjs   # 规则骨架自检（技能 frontmatter / 笔记格式 / AGENTS 章节）
```

## 约定

- TS + ESM，单入口 `src/index.ts`；函数插件导出 `name` / `Config` / `apply`，不设 default export。
- 配置项只放部署相关值；**API key 永不进配置**，一律走 `ctx.credentials`。
- 记忆写入永不自动落库：钩子只能写候审队列文件，批准后才调 mem0。
- 队列是文件（`pending.jsonl` 事实源 + `pending.md` 视图），落 `$DSH_HOME/memory-pending`；不放工作区、不挂 session scope。
- 候选事实必须带去重键（归一化文本的 hash），重复不入队。
- 候审项有 TTL（默认 7 天），过期归档，队列不无限增长。
- `dsh-better-sidebar` 是可选依赖：未安装时只保留 host 侧能力，Tab 不注册。
- 配置解析语义要有断言：schemastery 会替未配置字段填值（`z.array()` → `[]`，`z.string().default('')` → `''`），不要凭 schema 形状假设。

## 防御模式

- **凭据**：只经 `ctx.credentials.resolve()` 读取；缺凭据时明确报错并指出配置位置，不得回退到硬编码默认值。
- **记忆污染**：沿用 `dsh-memory` 技能的六问校验；新旧事实冲突必须 `supersede`，禁止并存。
- **网络**：mem0 调用必须有超时与失败分类（网络 / 鉴权 / 4xx / 5xx）；钩子内失败 fail-open，不阻断会话。
- **钩子预算**：SessionStart/Stop 的 handle 快速返回（超时即被放弃）；Stop 抽取失败只记日志，不留半条候审项。
- **UI 通道**：client 侧 Tab 读不到文件系统，必须经 host 暴露的 route/wire；不得把客户端状态当队列的事实源。

## 类型与文档规范

- `strict: true` + `noUncheckedIndexedAccess`；避免 `any`，必要断言写清理由。
- 每个模块与导出都有 JSDoc：模块头写职责，导出写契约（参数、返回、失败）。
- 配置项逐个注明"空值时的回退来源"。
- 描述失败与边界用具体词（如"凭据缺失时抛 X"），不用泛化的 shape/boundary 说法。

## 编辑规则

- 编辑本文件（真实文件）；规则保持一条一行、主题分节、指向真实工具/技能名。
- 通用跨工作区规则放 ~/.dsh/AGENTS.md（引用即可，不复制）；本项目特有规则放这里，具体覆盖一般。

## 变更自检与开发流程

1. 改 `src/` 或配置：`npm run typecheck && npm test`。
2. 改 bundle 装配或入口：额外跑 `npm run build`，确认生成 `lib/index.js`。
3. 改规则 / 技能 / 笔记：`node scripts/check.mjs`。
4. 发版前按 `.agents/skills/memory-pre-push-checks/SKILL.md` 选最小检查集；tag 前确认 `cordis.patch.yml` 能被宿主解析。
