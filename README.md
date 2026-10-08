# dsh-memory

DSH（DeepSeek Harness）的长期记忆插件：把自托管 mem0 接进 DSH —— TS 直连 REST，不再经过 Python MCP 桥。

## 它做什么

- **工具面**：`memory_remember` / `memory_recall` / `memory_read` / `memory_supersede` / `memory_inventory` / `memory_brief` / `memory_review`。
- **自动召回**：SessionStart 注入按分类分组的摘要（≤1200 字符）；每个 prompt 按需检索 top-3（≤600 字符，低于阈值不注入）。
- **候审队列**：Stop 把本轮候选事实写进 `$DSH_HOME/memory-pending/`，**批准后才落库**。
- **侧边栏待审页**：装了 `dsh-better-sidebar` 时注册「记忆待审」Tab（读 `/memory/pending`）；未装时用 `memory_review` 工具。
- **技能**：内置写入规则（`skill/dsh-memory.md`），随包分发，经 `ctx.skills` 注册。

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
- id: memory
  name: dsh-memory
  config:
    baseUrl: ''          # 空 = 取 MEM0_BASE_URL 凭据
    userId: ''           # 空 = 取 MEM0_USER_ID 凭据
    pendingDir: ''       # 空 = $DSH_HOME/memory-pending
    recall: true         # SessionStart 注入摘要
    capture: true        # Stop 写候审队列
    pendingTtlDays: 7    # 未处理候选的存活天数
    captureThreshold: 0.6
    maxPerTurn: 5
```

## 凭据

`MEM0_API_KEY` / `MEM0_BASE_URL` / `MEM0_USER_ID` 经 `ctx.credentials` 读取（`~/.dsh/.credentials.yaml` 或进程环境变量），**每次操作重新解析**，密钥永不进配置。

## 开发

```sh
npm install
npm run typecheck        # tsc -p tsconfig.json
npm test                 # node --import tsx --test（76 用例）
npm run build            # tsdown：lib/index.js（host）+ lib/client.js（client）
node scripts/check.mjs   # 规则骨架自检
```

写路径的测试全部跑在本地 stub server 上；真 mem0 只做只读验证。设计与取舍见 [`.agents/notes/implemented/architecture/2026-10-08-dsh-memory-design.md`](.agents/notes/implemented/architecture/2026-10-08-dsh-memory-design.md)。

## 从 Python MCP 桥迁移

1. 安装本插件（GUI 或 CLI），确认 `memory_recall` / `memory_inventory` 与旧 MCP 工具返回同一结果集。
2. 从 profile 移除 `mcp-mem0` 条目，并清掉 `cordis.patch.yml` 里的明文 `MEM0_API_KEY`（改用凭据服务）。
3. 回滚：把 `mcp-mem0` 条目加回 profile patch 并重启。
