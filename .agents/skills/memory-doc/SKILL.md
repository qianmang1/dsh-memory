---
name: memory-doc
description: Use when 创建/重构/评审/审计 dsh-memory 的 Markdown 文档、README、注释或官网内容，按受众优先层级与项目规范维护。
---

# memory Documentation

官方范本：examples/official/skills/dsh-doc/SKILL.md（裁剪版）。

## 触发条件

- 新增/移动/精简/评审文档、README、JSDoc；改文档类配置（链接、结构）

## 步骤

1. 先读 AGENTS.md「类型与文档规范」节；本仓库文档入口是根 `AGENTS.md`、`README.md`、`.agents/notes/` 与 `src/**` 的 JSDoc。
2. 按受众优先层级组织：模块头写职责、导出写契约（参数/返回/失败）；一个事实只写在一处，其它位置用相对链接；每段占一个物理行。
3. 文档随代码变更同步更新；删减前先查引用：
   ~~~sh
   rg -n "<被删标题或文件名>" -g "*.md" .
   ~~~

## 自检

- 无死链；事实与代码同步；相对链接指向存在的文件
- 交付前 `node scripts/check.mjs` 通过

## 边界

- 不把文档当交流记录写（"为什么"归 `.agents/notes/`）
- 尚未存在的文件（如 README.md）不假装维护它——先创建再引用
