---
name: memory-code-review
description: Use when 评审 dsh-memory 的 pull request 或本地改动，对照 AGENTS.md 章节、决策记录与自检门槛给出结构化评审。
---

# memory Code Review

官方范本：examples/official/skills/dsh-code-review/SKILL.md（裁剪版）。

## 触发条件

- 评审 PR / 分支 / 本地未提交改动
- 被要求 review、或自审大幅改动

## 步骤

1. 先读 AGENTS.md 的「约定」「防御模式」「类型与文档规范」三节，建立评审基准。
2. 看变更范围与相关决策记录：
   ~~~sh
   git diff --stat
   ls .agents/notes/proposed/**/*.md .agents/notes/implemented/**/*.md
   ~~~
3. 逐项核对：行为测试覆盖、文档随动、防御模式（凭据只走 `ctx.credentials`、写入不落库、队列带去重键与 TTL）、types 严格度、重复实现。
4. 输出结论：批准 / 需修改（逐条可执行）/ 拒绝（给理由）。

## 自检

- 每条意见都指向具体文件/行与 AGENTS.md 或笔记里的依据
- 本仓库评审必须过的门禁：`npm run typecheck && npm test`；改到 bundle 装配时加 `npm run build`；改到规则/技能/笔记时加 `node scripts/check.mjs`

## 边界

- 不做代码以外的评审（设计变更走 `.agents/notes/`）
- 不评审 WIP / 草稿分支，除非作者明确要求
