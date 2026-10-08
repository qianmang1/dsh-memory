# 项目级技能规范

本目录（.agents/skills/）由 DSH 自动发现（来源 project-agents）。每个技能一个目录 <域>-<名>/SKILL.md，**无注册步骤**。

## SKILL.md 结构（官方样式）

~~~markdown
---
name: <域>-<名>
description: Use when <触发场景>…一句话，进技能目录供 agent 判断何时调用
---

# 标题

## 触发条件（何时启用）

## 步骤（怎么做，写可执行命令）

## 自检（完成标准，可量化）

## 边界（何时不套用）
~~~

## 必须满足

- frontmatter 含 name（=目录名）与 description（含触发词；缺则不会出现在目录）
- 步骤可执行：命令真实、路径相对项目根
- 有自检与边界；不写“为什么要做”（留给 .agents/notes/）
- 新技能跑 node scripts/check.mjs 通过

## 与脚本的分工

- 可执行工具（.cmd/.bat/.ps1/.py）放 scripts/<域>/；SKILL.md 里调用它们，不内联长命令
- 封装新技能前先确认用户级 ~/.dsh/skills/ 与 ~/.agents/skills/ 没有同职责技能（不重复造）
- 范本：本技能由 dsh-project-init 初始化，官方技能原文在 ~/.dsh/skills/dsh-project-init/examples/official/skills/，裁剪时读它们
