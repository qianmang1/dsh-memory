---
name: memory-pre-push-checks
description: Use when 推送/force-push/标 ready for review/声称检查通过前，为 dsh-memory 选最小覆盖 diff 的本地检查，不反射性跑全量套件。
---

# memory Pre-Push Checks

官方范本：examples/official/skills/dsh-pre-push-checks/SKILL.md（本文件为其裁剪版）。

## 触发条件

- 推送、force-push、标记 ready for review、声称检查通过之前
- 合并到 main、打 tag 之前

## 步骤

1. 查看变更与基提交：
   ~~~sh
   git status --short --branch
   git diff --stat
   ~~~
2. 按变更类型选最小集（命令都在本仓库存在）：
   - 改 `src/`、`tests/` 或配置契约 → `npm run typecheck && npm test`
   - 改 `cordis.patch.yml` 或入口/导出 → 上面两条 + `npm run build`（确认生成 `lib/index.js`）
   - 改 `AGENTS.md`、`.agents/skills/`、`.agents/notes/` → `node scripts/check.mjs`
3. 只跑一遍所需检查；已通过的检查不重复；CI 负责全量与平台矩阵。

## 自检

- 所列命令都在本项目真实存在并跑过（本文件写定时跑过 `npm test`）
- 交付前 `node scripts/check.mjs` 通过

## 边界

- 不默认全量套件；仅用户显式要求、CI 诊断、或仓库级变更时才本地全量排练
- 打 tag 前必须先确认 `cordis.patch.yml` 能被宿主解析——坏 patch 会让 profile 启不来，这是本仓库不可绕过的门槛
