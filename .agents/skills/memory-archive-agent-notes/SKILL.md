---
name: memory-archive-agent-notes
description: Use when 新增/审计/归档/恢复 .agents/notes/ 决策记录时，检查 supersession（被取代的 active 记录）、按 implemented/proposed/rejected/archived 生命周期归类。
---

# memory Archive Agent Notes

官方范本：examples/official/skills/dsh-archive-agent-notes/SKILL.md（裁剪版）。

## 触发条件

- 写新决策记录、发现同主题旧记录、或要归档过时 implemented 记录时

## 步骤

1. 新记录写入前，先执行 supersession 检查（.agents/notes/README.md 规则）：同主题 active 记录已存在 → 更新它；被推翻 → 新记录交叉链接。
2. implemented 记录决策完成且不再指导未来工作时，整体移入 archived/{kind}/，在 Status 下插入 Archived: yyyy-mm-dd。
3. 归档后永久冻结，不再编辑/移动/删除；proposed 过时直接 rejected 或删除。

## 自检

- 改动后 node scripts/check.mjs 通过（命名、状态行、implemented 时态节）
- 归档只含允许的三类内容变更（移动/插 Archived 行/修入链）

## 边界

- 不编辑 archived/ 冻结记录；不把 implemented 记录改写成其反面
- 不按字数/年龄/配额机械归档，按“是否还指导未来工作”判断
