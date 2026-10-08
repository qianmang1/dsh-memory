/**
 * Tool surface — the `memory_*` tools the model calls.
 *
 * Every tool resolves credentials per call (the client factory re-resolves), so
 * a rotated key reaches the next call without a restart. Descriptions are
 * model-facing: they say what the tool does to the shared memory, not how it is
 * implemented.
 * @module dsh-memory/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import { buildBrief } from './brief.ts'
import type { MemoryMetadata, MemoryRow, Mem0Client } from './mem0.ts'

/** The client factory the tools use; resolving inside keeps the key out of long-lived state. */
export interface ToolDeps {
  /** Build a client for one operation, resolving credentials at that moment. */
  client(): Promise<Mem0Client>
}

/** Metadata assembled from the scalar tool parameters. */
function metadataFrom(args: {
  category?: string
  scope?: string
  importance?: string
  project?: string
  tags?: string
  source?: string
}): MemoryMetadata {
  const metadata: MemoryMetadata = {}
  if (args.category !== undefined) metadata.category = args.category
  if (args.scope !== undefined) metadata.scope = args.scope
  if (args.importance !== undefined) metadata.importance = args.importance
  if (args.project !== undefined) metadata.project = args.project
  if (args.source !== undefined) metadata.source = args.source
  if (args.tags !== undefined) {
    const tags = args.tags.split(',').map((tag) => tag.trim()).filter((tag) => tag.length > 0)
    if (tags.length > 0) metadata.tags = tags
  }
  return metadata
}

/** One rendered line per memory, newest information first-class and id-addressable. */
function renderRows(rows: readonly MemoryRow[]): string {
  if (rows.length === 0) return '没有匹配的记忆。'
  return rows
    .map((row) => {
      const meta = row.metadata
      const facts = [meta.category, meta.scope, meta.importance].filter((value): value is string => value !== undefined)
      const suffix = facts.length === 0 ? '' : `（${facts.join(' · ')}）`
      const score = row.score === undefined ? '' : ` score=${row.score.toFixed(3)}`
      return `- [${row.id.slice(0, 8)}] ${row.memory}${suffix}${score}`
    })
    .join('\n')
}

/** The shared shape of a rendered list of memories. */
const LIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    count: { type: 'number', required: true, description: 'Number of memories returned.' },
    memories: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          memory: { type: 'string', required: true },
          category: { type: 'string' },
          scope: { type: 'string' },
          importance: { type: 'string' },
          status: { type: 'string' },
          score: { type: 'number' },
        },
      },
    },
    text: { type: 'string', required: true, description: 'The same list rendered for the model.' },
  },
} as const

/** One item of the list schema; optional fields are omitted rather than set to undefined. */
interface ListItem {
  id: string
  memory: string
  category?: string
  scope?: string
  importance?: string
  status?: string
  score?: number
}

/** Project service rows into the list schema's item shape. */
function toListItems(rows: readonly MemoryRow[]): ListItem[] {
  return rows.map((row): ListItem => ({
    id: row.id,
    memory: row.memory,
    ...row.metadata.category === undefined ? {} : { category: row.metadata.category },
    ...row.metadata.scope === undefined ? {} : { scope: row.metadata.scope },
    ...row.metadata.importance === undefined ? {} : { importance: row.metadata.importance },
    ...row.metadata.status === undefined ? {} : { status: row.metadata.status },
    ...row.score === undefined ? {} : { score: row.score },
  }))
}

/**
 * Register the memory tools.
 * @param ctx Host context; registrations are effects scoped to it.
 * @param deps Client factory.
 */
export function registerMemoryTools(ctx: Context, deps: ToolDeps): void {
  ctx.tools.register(defineTool({
    name: 'memory_remember',
    description: '长期记忆：写入一条事实（默认保真写入，不做 LLM 改写）。用于记住用户明确表达、且跨会话仍然成立的偏好、约束、决策或工作方式。',
    parameters: {
      text: { type: 'string', required: true, description: '要记住的事实，一句话，保留用户原话中的关键措辞。' },
      category: { type: 'string', description: 'fact | preference | project | person | relation | decision | constraint | goal | workflow' },
      scope: { type: 'string', description: 'user | project | agent | session；session 级信息不要写入长期记忆。' },
      importance: { type: 'string', description: 'permanent | long_term | temporary' },
      project: { type: 'string', description: 'scope=project 时的项目名。' },
      tags: { type: 'string', description: '逗号分隔的标签。' },
      infer: { type: 'boolean', description: 'true 时交给服务端抽取改写（可能改写措辞）；默认 false 保真写入。' },
    },
    output: {
      schema: LIST_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: `已写入 ${value.count} 条：\n${value.text}` }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const client = await deps.client()
      const rows = await client.remember({
        text: args.text,
        metadata: metadataFrom(args),
        infer: args.infer ?? false,
      })
      return { count: rows.length, memories: toListItems(rows), text: renderRows(rows) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_recall',
    description: '长期记忆：按语义检索相关记忆。在回答依赖用户既有偏好、约定或历史决策时使用；不要求关键词匹配。',
    parameters: {
      query: { type: 'string', required: true, description: '自然语言查询，例如“用户对输出的偏好”。' },
      top_k: { type: 'number', description: '最多返回条数，默认 10。' },
      category: { type: 'string', description: '只返回该分类。' },
      scope: { type: 'string', description: '只返回该作用域：user | project | agent | session。' },
      include_historical: { type: 'boolean', description: '是否包含已被取代（historical）的事实，默认 false。' },
    },
    output: {
      schema: LIST_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: value.count === 0 ? '没有匹配的记忆。' : `匹配到 ${value.count} 条：\n${value.text}`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const client = await deps.client()
      const rows = await client.recall({
        query: args.query,
        topK: args.top_k ?? 10,
        ...args.category === undefined ? {} : { category: args.category },
        ...args.scope === undefined ? {} : { scope: args.scope },
        ...args.include_historical === undefined ? {} : { includeHistorical: args.include_historical },
      })
      return { count: rows.length, memories: toListItems(rows), text: renderRows(rows) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_read',
    description: '长期记忆：按 id 读取一条记忆的完整内容与元数据。',
    parameters: {
      id: { type: 'string', required: true, description: '记忆 id（memory_recall / memory_inventory 返回的完整 id）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          found: { type: 'boolean', required: true },
          id: { type: 'string' },
          memory: { type: 'string' },
          text: { type: 'string', required: true },
        },
      },
      // The canonical value already carries the human-readable body; metadata
      // rides inside `text` as JSON rather than a second structured field that
      // would have to satisfy the JSON-value type for no reader.
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const client = await deps.client()
      const row = await client.read(args.id)
      if (row === undefined) return { found: false, text: '没有找到该 id 的记忆。' }
      return {
        found: true,
        id: row.id,
        memory: row.memory,
        text: `${row.memory}\n元数据：${JSON.stringify(row.metadata)}`,
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_supersede',
    description: '长期记忆：用新事实取代一条旧记忆（旧条标记为 historical，新条带 supersedes 指针）。当新信息与已存记忆矛盾时使用——不要并存两条互相矛盾的事实。',
    parameters: {
      old_id: { type: 'string', required: true, description: '被取代的旧记忆 id。' },
      text: { type: 'string', required: true, description: '取代后的新事实。' },
      category: { type: 'string', description: '新条目的分类；省略则沿用旧条的展示字段。' },
      scope: { type: 'string', description: '新条目的作用域。' },
      importance: { type: 'string', description: '新条目的重要度。' },
      project: { type: 'string', description: '所属项目名。' },
      source: { type: 'string', description: '来源标识，例如会话 id。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          superseded_id: { type: 'string', required: true },
          count: { type: 'number', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已取代 ${value.superseded_id.slice(0, 8)}，新写入 ${value.count} 条：\n${value.text}`,
      }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const client = await deps.client()
      const result = await client.supersede({
        oldId: args.old_id,
        text: args.text,
        metadata: metadataFrom(args),
      })
      return {
        superseded_id: result.supersededId,
        count: result.created.length,
        text: renderRows(result.created),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_inventory',
    description: '长期记忆：盘点记忆库，按分类、作用域、状态或重要度过滤。用于审计、查重和回答“我记得哪些”。',
    parameters: {
      top_k: { type: 'number', description: '最多返回条数，默认 50。' },
      category: { type: 'string', description: '只返回该分类。' },
      status: { type: 'string', description: 'current | historical；默认不过滤。' },
      scope: { type: 'string', description: 'user | project | agent | session。' },
      importance: { type: 'string', description: 'permanent | long_term | temporary。' },
    },
    output: {
      schema: LIST_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: value.count === 0 ? '记忆库中没有符合条件的条目。' : `共 ${value.count} 条：\n${value.text}`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const client = await deps.client()
      const rows = await client.inventory({
        topK: args.top_k ?? 50,
        ...args.category === undefined ? {} : { category: args.category },
        ...args.status === undefined ? {} : { status: args.status },
        ...args.scope === undefined ? {} : { scope: args.scope },
        ...args.importance === undefined ? {} : { importance: args.importance },
      })
      return { count: rows.length, memories: toListItems(rows), text: renderRows(rows) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_brief',
    description: '长期记忆：生成一段按分类分组的用户画像摘要。在需要“这个用户是谁、长期偏好什么”时使用，比逐条检索更省上下文。',
    parameters: {
      max_chars: { type: 'number', description: '摘要的字符预算，默认 1200。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number', required: true },
          brief: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.brief.length === 0 ? '记忆库为空。' : value.brief }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const client = await deps.client()
      const rows = await client.inventory({ topK: 200 })
      return { count: rows.length, brief: buildBrief(rows, { maxChars: args.max_chars ?? 1200 }) }
    },
  }))
}
