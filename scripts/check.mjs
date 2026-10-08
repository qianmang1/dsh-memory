#!/usr/bin/env node
// dsh-memory 自检：技能 frontmatter / 笔记命名与格式 / AGENTS.md 章节完整性与去重 / 范本-生成物一致性。
// 用法：node scripts/check.mjs [项目根目录]
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = process.argv[2] ?? dirname(fileURLToPath(import.meta.url)).replace(/[\\/]scripts$/, '')
const problems = []
const notes = []
const warn = (msg) => notes.push('WARN  ' + msg)
const fail = (msg) => problems.push(msg)

const LIFECYCLES = ['proposed', 'implemented', 'rejected', 'archived']
const CLASSES = ['feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing']
const REQUIRED_SECTIONS = ['项目定位', '布局', '命令', '约定', '防御模式', '类型与文档规范', '编辑规则', '变更自检与开发流程']
const FENCE = /^(~~~+|\x60{3})/

// ---------- 1. AGENTS.md 章节完整性与去重 ----------
const agentsFile = join(root, 'AGENTS.md')
if (!existsSync(agentsFile)) {
  fail('AGENTS.md 不存在（目标未初始化或已删除）')
} else {
  const text = readFileSync(agentsFile, 'utf8')
  const heads = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim())
  for (const req of REQUIRED_SECTIONS) {
    if (!heads.includes(req)) fail('AGENTS.md 缺必需章节 ## ' + req)
  }
  const seen = new Set()
  for (const h of heads) {
    if (seen.has(h)) fail('AGENTS.md ## ' + h + ' 章节重复')
    seen.add(h)
  }
  if (!/~\/\.dsh\/AGENTS\.md/.test(text)) fail('AGENTS.md 顶层未引用 ~/.dsh/AGENTS.md 通用规则')
  if (/@deepseek-ai|deepseek-harness|pnpm (run|workspace|install)/.test(text)) {
    warn('AGENTS.md 疑似残留官方仓库专属约定（@deepseek-ai / deepseek-harness / pnpm），请替换为本项目真实技术栈')
  }
}

// ---------- 2. 技能 frontmatter ----------
const skillsDir = join(root, '.agents', 'skills')
if (existsSync(skillsDir)) {
  const skillDirs = readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(skillsDir, d.name, 'SKILL.md')))
  if (skillDirs.length === 0) fail('.agents/skills/ 下没有任何 SKILL.md 技能')
  for (const d of skillDirs) {
    const text = readFileSync(join(skillsDir, d.name, 'SKILL.md'), 'utf8')
    const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!fm) { fail('skill ' + d.name + ': 缺 frontmatter'); continue }
    const name = fm[1].match(/^name: (.+)$/m)?.[1]?.trim() ?? ''
    const desc = fm[1].match(/^description: (.+)$/m)?.[1]?.trim() ?? ''
    if (name !== d.name) fail('skill ' + d.name + ': frontmatter name 与目录名不一致（' + name + '）')
    if (desc.length < 10 || !/Use when|当用户|触发|使用/.test(desc)) fail('skill ' + d.name + ': description 缺触发词或过短')
    const body = text.replace(/^---[\s\S]*?---/, '')
    for (const sec of ['## 触发条件', '## 自检', '## 边界']) {
      if (!body.includes(sec)) fail('skill ' + d.name + ': 缺 ' + sec + ' 节')
    }
  }
} else {
  fail('.agents/skills/ 目录不存在')
}

// ---------- 3. 笔记命名 / 结构 / 格式 ----------
const notesDir = join(root, '.agents', 'notes')
if (existsSync(notesDir)) {
  const top = readdirSync(notesDir, { withFileTypes: true })
  for (const e of top) {
    if (e.isFile() && !['README.md', 'AGENTS.md', 'CLAUDE.md'].includes(e.name)) {
      fail('.agents/notes/' + e.name + ': 顶层只允许 README.md/AGENTS.md/CLAUDE.md')
    }
    if (e.isDirectory() && !LIFECYCLES.includes(e.name)) {
      fail('.agents/notes/' + e.name + ': 未知生命周期目录（允许 ' + LIFECYCLES.join('/') + '）')
    }
  }
  for (const lc of LIFECYCLES) {
    const lcDir = join(notesDir, lc)
    if (!existsSync(lcDir)) { fail('.agents/notes/' + lc + '/ 不存在'); continue }
    for (const c of readdirSync(lcDir, { withFileTypes: true })) {
      const cp = join(lcDir, c.name)
      if (c.isDirectory()) {
        if (!CLASSES.includes(c.name)) {
          fail('.agents/notes/' + lc + '/' + c.name + ': 未知分类目录（允许六类）')
        } else {
          for (const f of readdirSync(cp, { withFileTypes: true })) {
            if (f.isFile() && f.name.endsWith('.md') && !/^\d{4}-\d{2}-\d{2}-.+\.md$/.test(f.name)) {
              fail('.agents/notes/' + lc + '/' + c.name + '/' + f.name + ': 文件名须 yyyy-mm-dd-主题.md')
            }
          }
        }
      } else if (!['README.md', 'AGENTS.md', 'CLAUDE.md'].includes(c.name)) {
        fail('.agents/notes/' + lc + '/' + c.name + ': 生命周期根只允许 README.md/AGENTS.md/CLAUDE.md')
      }
    }
  }
  // 正文格式 / 状态行 / implemented 时态
  for (const lc of ['proposed', 'implemented', 'rejected']) {
    for (const c of CLASSES) {
      const cp = join(notesDir, lc, c)
      if (!existsSync(cp)) continue
      for (const f of readdirSync(cp)) {
        if (!f.endsWith('.md') || f.endsWith('.zh.md')) continue
        const rel = lc + '/' + c + '/' + f
        const content = readFileSync(join(cp, f), 'utf8')
        const lines = content.split(/\r?\n/)
        if (!/^# Agent Note: \S/.test(lines[0] ?? '')) fail(rel + ': 第 1 行须 # Agent Note: <标题>')
        if ((lines[1] ?? '') !== '') fail(rel + ': 第 2 行须空行')
        const status = (lines[2] ?? '').trim()
        if (lc === 'proposed' && status !== 'Status: proposed') fail(rel + ': Status 须为 proposed')
        if (lc === 'implemented' && status !== 'Status: implemented') fail(rel + ': Status 须为 implemented')
        if (lc === 'rejected' && !/^Status: rejected — .+/.test(status)) fail(rel + ': Status 须为 rejected — <一句话原因>')
        let inFence = false
        const h2 = []
        for (const l of lines) {
          if (FENCE.test(l)) { inFence = !inFence; continue }
          if (!inFence && /^## /.test(l)) h2.push(l.trim())
        }
        if (h2[0] !== '## Problem') fail(rel + ': 首节须为 ## Problem')
        if (lc === 'implemented' && !h2.includes('## Decision')) fail(rel + ': 缺 ## Decision（implemented 现在时）')
        if (lc === 'implemented' && /^## (Proposal|Plan|Migration plan|Acceptance criteria)\b/i.test(h2.join('\n'))) {
          fail(rel + ': 出现提案时态节（## Proposal/Plan/Migration plan/Acceptance criteria），应并入 Decision/Consequences')
        }
        if (!h2.includes('## Alternatives considered')) fail(rel + ': 缺 ## Alternatives considered（备选不记录即会重提讼争）')
      }
    }
  }
  for (const c of CLASSES) {
    const cp = join(notesDir, 'archived', c)
    if (!existsSync(cp)) continue
    for (const f of readdirSync(cp)) {
      if (!f.endsWith('.md') || f.endsWith('.zh.md')) continue
      const content = readFileSync(join(cp, f), 'utf8')
      if (!/^Archived: \d{4}-\d{2}-\d{2}/m.test(content)) fail('archived/' + c + '/' + f + ': 冻结记录须含 Archived: yyyy-mm-dd 行')
    }
  }
} else {
  fail('.agents/notes/ 目录不存在')
}

// ---------- 4. 范本-生成物一致性（骨架路径集） ----------
const EXPECTED = [
  '.agents/skills/README.md',
  '.agents/notes/README.md',
  '.agents/notes/implemented/AGENTS.md',
  'scripts/check.mjs',
  'scripts/README.md',
]
for (const lc of LIFECYCLES) {
  for (const c of CLASSES) {
    if (!existsSync(join(root, '.agents', 'notes', lc, c))) {
      fail('骨架缺目录 .agents/notes/' + lc + '/' + c + '（决策记录分类体系不完整）')
    }
  }
}
for (const p of EXPECTED) {
  if (!existsSync(join(root, p))) fail('骨架缺 ' + p + '（与范本结构不一致）')
}

// ---------- 汇总 ----------
for (const n of notes) console.log(n)
if (problems.length) {
  console.error('FAIL: ' + problems.length + ' 处')
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}
console.log('OK: dsh-memory 自检通过（技能 frontmatter / 笔记命名格式 / AGENTS.md 章节完整性与去重 / 范本一致性）')
