# dsh-memory

DSH（DeepSeek Harness）的长期记忆插件：把自托管 mem0 接进 DSH —— TS 直连 REST，不再经过 Python MCP 桥。

## 它做什么

- **五个可独立开关的组件**（插件页每个组件一个开关，随开随停）：

  | 组件 | 入口 | 职责 | 关掉后 |
  |---|---|---|---|
  | `memory-core` | `dsh-memory` | 六个记忆工具 + 技能规则 | 模型失去全部 memory_* 工具 |
  | `memory-recall` | `dsh-memory/recall` | SessionStart 摘要注入 + 每步召回注入 | 不再向上下文注入任何记忆 |
  | `memory-capture` | `dsh-memory/capture` | Stop 捕获候选事实 → 候审队列 | 本轮对话不再产生候选 |
  | `memory-review` | `dsh-memory/review` | `memory_review` 工具 + 侧边栏待审路由 | 人工审批入口消失（队列文件保留） |
  | `memory-debug` | `dsh-memory/debug` | 追踪环闸门 + `memory_debug` 工具 + 启动自检 + NDJSON 落盘 | **全部组件的追踪输出即刻停止**，诊断工具下线 |

- **工具面**：六个记忆工具（core）+ `memory_review`（review）+ `memory_debug`（debug，随组件开关上线下线）。`memory_remember` **默认提交候审队列**（人工批准后才写 mem0）；确需立即入库可传 `direct: true` 逃生门。
- **自动召回**：SessionStart 注入按分类分组的摘要（≤1200 字符）；每个 prompt 按需检索 top-3（≤600 字符，低于阈值不注入）。
- **候审队列**：Stop 自动捕获的候选事实与 `memory_remember` 工具提交的条目都写进 `$DSH_HOME/memory-pending/`（文本去重），**批准后才落库**。
- **侧边栏待审页**：注册进 DSH **原生右侧栏**（与官方「会话数据诊断」同一契约）——右栏「新标签页」→ 引导页点「记忆待审」。每条候选一张卡片：折叠两行省略、点击展开全文；分类/范围/置信度徽章全中文；批准/驳回走 `/memory/pending`，与 `memory_review` 工具共用同一决策流（去重 → supersede 或保真写入 → 记录）。
- **技能**：内置写入规则（`skill/dsh-memory.md`），随包分发，经 `ctx.skills` 注册。
- **运行时追踪**：钩子触发、mem0 请求（只记 method/状态/耗时/字节数，不记内容）、队列迁移、决策链路都进环形缓冲；`memory_debug` 工具随时可查（测试和排障用）。
- **启动自检**：debug 模式下每次挂载逐模块输出状态日志（config / tools / skill / route / queue / tracer / credentials / mem0 连通）。

**写入永不自动落库**：这个库曾被单日批量导入污染过一次（107 条冗余），自动写入必须留在人工闸门后面。Stop 只产候选，`memory_remember` 也只入候审队列——批准是一步显式动作。

## 安装

`desktop` profile（Electron 宿主）只能经 GUI 的插件入口安装 —— CLI 会拒绝：

```
error: profile "desktop" is managed exclusively by the Electron application
```

非 Electron profile（如 `web`）用 CLI（它内部就是 pnpm）：

```sh
cd ~/.dsh && dsh plugin --profile web add <spec>
```

本地开发时也可以直接把 profile 依赖指向工作区（`file:`）+ 手工 `pnpm install`，再重启宿主。

## 配置

```yaml
# 每个组件一行，独立开关；pendingDir 四处必须一致（空 = $DSH_HOME/memory-pending）。
# debug 行排第一：兄弟组件的启动自检状态行要赶得上汇总。
- insert:
    - id: memory-debug
      name: dsh-memory/debug
      config: { debugLog: false, pendingDir: '' }
    - id: memory-core
      name: dsh-memory/core
      config: { baseUrl: '', userId: '', pendingDir: '' }
    - id: memory-recall
      name: dsh-memory/recall
      config: { baseUrl: '', userId: '', brief: true, recall: true }
    - id: memory-capture
      name: dsh-memory/capture
      config: { pendingDir: '', captureThreshold: 0.6, maxPerTurn: 5, pendingTtlDays: 7 }
    - id: memory-review
      name: dsh-memory/review
      config: { baseUrl: '', userId: '', pendingDir: '', dedupeThreshold: 0.8 }
```

**调试追踪**：追踪环与落盘都归 debug 组件管——组件开着，环形缓冲就在（`memory_debug` 工具读取，零配置）；落盘由 `debugLog: true` 或环境变量 `DSH_MEMORY_LOG=1` 开启。**关掉 debug 组件 = 五个组件的追踪输出全部停止**（共享闸门，见 `src/debug.ts`）。事件经脱敏清洗——含 key/token/secret 字样的键一律替换为 `[REDACTED]`，超长字符串截断，请求体永不入日志。

**启动自检**：`debugLog` 开启时（或 `DSH_MEMORY_LOG=1`），挂载时逐模块输出统一格式状态行：

```
dsh-memory [boot] tracer: SKIP — 仅内存环形缓冲（设 debugLog: true 或环境变量 DSH_MEMORY_LOG=1 启用落盘）
dsh-memory [boot] debug-tool: OK — memory_debug 已注册
dsh-memory [boot] tools: OK — 6 个记忆工具已注册
dsh-memory [boot] credentials: FAIL — 缺少 MEM0_API_KEY 凭据。把值写入 ~/.dsh/.credentials.yaml…
dsh-memory [boot] mem0: SKIP — 凭据未解析，跳过连通性检查
dsh-memory [boot] 自检完成：N 模块（ok=… warn=… fail=1 skip=…）——无 debug 组件时此报告整体不存在
```

- 模块：debug 组件自身的 tracer / debug-tool / skill-body / tracer 文件 / queue / credentials / mem0（连通 ping，GET topK=1），加上兄弟组件挂载时的 recall / capture / capture-config / review / route / tools / skill 行。debug 组件必须在 patch 里排第一个，兄弟组件的行才赶得上汇总。
- 级别：OK/SKIP 走 debug，WARN 走 warn，FAIL 走 error——**即使不开 debug，失败与警告也会出现在宿主日志里**；宿主无对应 logger 级别时静默降级为仅追踪。
- 常见 WARN：技能正文缺失、队列存在损坏行、待审积压 >50、mem0 连通 >2s。FAIL 一律带模块名与原因；API key 永不出现。
- 全部事件同时进追踪环，`memory_debug` 可事后回放启动报告。

## 凭据

`MEM0_API_KEY` / `MEM0_BASE_URL` / `MEM0_USER_ID` 经 `ctx.credentials` 读取（`~/.dsh/.credentials.yaml` 或进程环境变量），**每次操作重新解析**，密钥永不进配置。

## 开发

```sh
npm install
npm run typecheck        # tsc -p tsconfig.json
npm test                 # node --import tsx --test（111 用例）
npm run build            # tsdown：lib/{index,portal,core-plugin,recall,capture,review,debug-plugin}.js（host）+ lib/client.js（client 侧边栏）
node scripts/check.mjs   # 规则骨架自检
```

注意：host 构建**不清理** `lib/`（`clean: false`）——`lib/client.js` 与 host 产物同目录，early 版本曾因 clean 把 client 产物连带删掉，宿主报 `failed to import`。

写路径的测试全部跑在本地 stub server 上；真 mem0 只做只读验证。设计与取舍见 [`.agents/notes/implemented/architecture/2026-10-08-dsh-memory-design.md`](.agents/notes/implemented/architecture/2026-10-08-dsh-memory-design.md)。

## Web 开发迭代（HMR）

侧边栏 UI 在 `dev/web-ui` 分支开发，web profile 用 `link:` 协议直通工作区：

```sh
# profile package.json: "dsh-memory": "link:D:/DSH_work/dsh-memory"（dependencies + dsh.profile.bundles 两处登记）
pnpm dev:client   # watch lib/client.js，宿主 stat-poll 500ms 热替换，浏览器刷新即见
```

改 client 产物 → 刷新页面即可；改 `dsh.client.inject`（package.json）或 `cordis.patch.yml` → 必须重启宿主。宿主启动命令：`pnpm dsh web --no-open --port 3001`（在 dsh 源码检出内执行）。

## 从 Python MCP 桥迁移

1. 安装本插件（GUI 或 CLI），确认 `memory_recall` / `memory_inventory` 与旧 MCP 工具返回同一结果集。
2. 从 profile 移除 `mcp-mem0` 条目，并清掉 `cordis.patch.yml` 里的明文 `MEM0_API_KEY`（改用凭据服务）。
3. 回滚：把 `mcp-mem0` 条目加回 profile patch 并重启。
