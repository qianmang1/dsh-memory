# scripts/ — 可执行工具

- 可执行工具（.cmd/.bat/.ps1/.py/.mjs）按域分目录 scripts/<域>/；agent 流程写 .agents/skills/，技能里调用脚本，不内联长命令
- check.mjs：项目自检（node scripts/check.mjs）——技能 frontmatter、笔记命名与格式、AGENTS.md 章节完整性与去重、范本-生成物一致性
