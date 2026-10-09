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

- **工具面**：六个记忆工具（core）+ `memory_review`（review）+ `memory_debug`（debug，随组件开关上线下线）。
- **自动召回**：SessionStart 注入按分类分组的摘要（≤1200 字符）；每个 prompt 按需检索 top-3（≤600 字符，低于阈值不注入）。
- **候审队列**：Stop 把本轮候选事实写进 `$DSH_HOME/memory-pending/`，**批准后才落库**。
- **侧边栏待审页**：装了 `dsh-better-sidebar` 时注册「记忆待审」Tab（读 `/memory/pending`）；未装时用 `memory_review` 工具。
- **技能**：内置写入规则（`skill/dsh-memory.md`），随包分发，经 `ctx.skills` 注册。
- **运行时追踪**：钩子触发、mem0 请求（只记 method/状态/耗时/字节数，不记内容）、队列迁移、决策链路都进环形缓冲；`memory_debug` 工具随时可查（测试和排障用）。
- **启动自检**：debug 模式下每次挂载逐模块输出状态日志（config / tools / skill / route / queue / tracer / credentials / mem0 连通）。

**写入永不自动落库**：这个库曾被单日批量导入污染过一次（107 条冗余），自动写入必须留在人工闸门后面。Stop 只产候选，批准是一步显式动作。

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
# 每个组件一行，独立开关；pendingDir 三处必须一致（空 = $DSH_HOME/memory-pending）
- insert:
    - id: memory-debug
      name: dsh-memory/debug
      config: { debugLog: false, pendingDir: '' }
    - id: memory-core
      name: dsh-memory
      config: { baseUrl: '', userId: '' }
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
npm test                 # node --import tsx --test（108 用例）
npm run build            # tsdown：lib/{index,recall,capture,review,debug-plugin}.js（host 五入口）+ lib/client.js（client）
node scripts/check.mjs   # 规则骨架自检
```

写路径的测试全部跑在本地 stub server 上；真 mem0 只做只读验证。设计与取舍见 [`.agents/notes/implemented/architecture/2026-10-08-dsh-memory-design.md`](.agents/notes/implemented/architecture/2026-10-08-dsh-memory-design.md)。

## 从 Python MCP 桥迁移

1. 安装本插件（GUI 或 CLI），确认 `memory_recall` / `memory_inventory` 与旧 MCP 工具返回同一结果集。
2. 从 profile 移除 `mcp-mem0` 条目，并清掉 `cordis.patch.yml` 里的明文 `MEM0_API_KEY`（改用凭据服务）。
3. 回滚：把 `mcp-mem0` 条目加回 profile patch 并重启。
