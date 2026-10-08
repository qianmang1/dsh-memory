# 决策记录规范（Agent Notes）

记录本项目的“为什么”：决策、取舍、被否方案。路径 {lifecycle}/{kind}/yyyy-mm-dd-主题.md。

## 生命周期（顶层目录）

- proposed/ — 未实施（或只实施了一部分）的提案
- implemented/ — 已落地的决策；正文现在时，随实际落地保持更新（事实可改，决策本身不改）
- rejected/ — 被否的提案；只有在其理由能防止再犯时才保留，否则删除
- archived/ — 已归档（冻结），见下方「归档」

## 分类（kind）

feature（新能力）/ bug-fix（修缺陷）/ simplification（删代码/面积）/ architecture（源码结构决策）/ process（周边工具与流程）/ testing（测试基建与策略）六类；目录闭合，新增分类要同步改 scripts/check.mjs 与本 README。

## 命名

- 文件名 yyyy-mm-dd-主题.md（首次提出日期）
- 笔记间交叉引用用相对链接 [主题](../../implemented/architecture/2026-…-….md)，不用裸文字，保证可机械校验

## 正文格式

前三行固定：

~~~markdown
# Agent Note: <标题>

Status: <proposed | implemented | rejected — 一句话原因>
~~~

- 首节必须 ## Problem（动机，脱离方案也能读）
- 必须含 ## Alternatives considered：每个真实备选与落选原因，一条一段或以 ### Why not <X>? 成节；备选只记录不编造
- proposed 骨架：## Problem / ## Proposal / ## Alternatives considered / ## Acceptance criteria / ## Risks
- implemented 骨架：## Problem / ## Decision / …自由节… / ## Alternatives considered / ## Consequences；禁止提案时态节（## Proposal、## Acceptance criteria、## Plan、## Migration plan）
- 归档时在 Status: implemented 下加一行 Archived: yyyy-mm-dd

## Supersession 检查（新增/改动记录时）

1. 新记录前先搜 active 里同主题旧记录；已有则更新旧记录，不新建重复。
2. 新决策推翻旧决策：新记录注明并交叉链接旧记录；绝不把旧记录编辑成其反面（那是改写历史）。
3. 完全被取代的 implemented 记录：先保留其全部独有理由/备选/后果/验证要求，修复所有入链，再删除完整三元组（.md + .zh.md + .i18n.yaml，如有）。
4. 部分被取代不算完全取代：两条记录都要保留并交叉链接，把仍成立的事实更新到现行记录。

## 归档

- implemented 记录决策已完成且理由不再指导未来工作时，移入 archived/{kind}/ 冻结
- 归档只允许：整体移动、插入 Archived 行、修入链；之后**永久冻结**：不编辑、不翻译、不移动、不删除、不作为现行依据
- 永不归档 proposed：过时提案直接 rejected 或删除

## 与脚本分工

- 结构校验在 scripts/check.mjs（生命周期/分类闭合、命名、状态行、implemented 时态节）
