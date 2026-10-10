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
- `lib/` — 构建产物，**必须提交入库**：`lib/index.js`（host）与 `lib/client.js`（client）。npm 对 git 依赖只跑 `prepare`、**不跑 `prepack`**，所以"装的时候会自动构建"是错的（实测：`npm install github:…` 后 tarball 内 `package/lib/` 条目数为 0）。`prepack` 保留，供 registry 发布路径使用。

## 命令

```sh
pnpm install             # 依赖（首次）
pnpm run typecheck       # tsc -p tsconfig.json
pnpm test                # node --test "tests/**/*.test.ts"
pnpm run build           # tsdown → lib/index.js
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
- **侧边栏 Tab 走 `registerTab`，类型用官方声明**：待审页是一个完整的侧边栏标签页（有自己的面板内容与 `+` 菜单项），注册到 `dsh-better-sidebar`（上游 `omdsh-dev/DSH-better-sidebar`）的 `ctx.betterSidebar.registerTab(TabDescriptor)`，`SidebarTab` 的内容渲染器就是 descriptor 的 `component` 字段；`scope.sessionId` 来自 `SessionScope`（必填）。运行时仍用 `ctx.get('betterSidebar')`（该底座可选，缺失时降级到 `memory_review`），但 descriptor 与组件 props 的类型 `import type` 自 `dsh-better-sidebar`（仅 devDependency，不进发布清单）：字段改名会在 `pnpm run typecheck` 立刻报错，不再靠猜。官方 DSH 另有 `ctx.slots` 的 `sidebar.footer.action`（侧边栏底部的动作项，不是标签页），两者别混用。
- **依赖未满足 = 静默挂起**：cordis 不会因 `inject` 缺失报错，只会把插件挂起——症状是"服务不存在"（实测漏注册 `@deepseek-ai/dsh-system-prompt` 时 `ToolRuntime` 不发布，`ctx.tools` 为 undefined）。测试 harness 按依赖顺序注册；排查先看 `inject` 链，别先怀疑工具写错。
- **client 产物必须过加载器契约**：宿主把 `lib/client.js` 字节**原样拼接**进 combo script，用**经典 `<script>`** 注入，产物必须自己调 `window.__ModuleLoader__.load({id, factory})`。所以 client 段只能是 `format: 'cjs'` + banner/footer/intro（照 `deepseek-harness/packages/client/tsdown.client.ts` 的包装），**不能是 ESM**——ESM 顶层 `import` 是硬 `SyntaxError`，会让整个 web boot 失败（实测 `crash-*-web-boot.log`：`web boot: 1 entry did not activate`）。
- **boot 失败会触发宿主的破坏性恢复**：装载失败时 Electron 弹致命恢复对话框，其中"禁用第三方插件"按钮会调 `sanitizeProfile`——它把用户手写的 `cordis.patch.yml` **整体改名**成 `.bak-<epoch-ms>`，并把 `dsh.profile.bundles` **整体替换**成内置 web 模板（只剩 base + web-app）。即：一个插件装载失败，可能连带清掉其它所有插件。改 client/装配后务必先在本机装上验证，再宣告可用。

## 类型与文档规范

- `strict: true` + `noUncheckedIndexedAccess`；避免 `any`，必要断言写清理由。
- 每个模块与导出都有 JSDoc：模块头写职责，导出写契约（参数、返回、失败）。
- 配置项逐个注明"空值时的回退来源"。
- 描述失败与边界用具体词（如"凭据缺失时抛 X"），不用泛化的 shape/boundary 说法。

## 编辑规则

- 编辑本文件（真实文件）；规则保持一条一行、主题分节、指向真实工具/技能名。
- 通用跨工作区规则放 ~/.dsh/AGENTS.md（引用即可，不复制）；本项目特有规则放这里，具体覆盖一般。

## 变更自检与开发流程

1. 改 `src/` 或配置：`pnpm run typecheck && pnpm test`。
2. 改 bundle 装配或入口：额外跑 `pnpm run build`，确认生成 `lib/index.js`。
3. 改规则 / 技能 / 笔记：`node scripts/check.mjs`。
4. 发版前按 `.agents/skills/memory-pre-push-checks/SKILL.md` 选最小检查集；tag 前确认 `cordis.patch.yml` 能被宿主解析。
