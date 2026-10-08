/**
 * The review tool — the queue's non-UI door.
 *
 * Approval is where the design's "never write automatically" rule is cashed in,
 * so the flow is explicit and ordered:
 * 1. search for the same fact,
 * 2. if a strong hit exists, supersede it (old row historical, new row carrying
 *    the pointer) instead of leaving two contradicting rows,
 * 3. otherwise write faithfully with `infer:false`,
 * 4. record the decision, including the mem0 id, so the queue stays auditable.
 *
 * The sidebar tab calls the same flow through the host route; this tool exists
 * so review still works when that optional plugin is absent.
 * @module dsh-memory/review
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { Mem0Client } from './mem0.ts'
import type { PendingEntry, PendingQueue } from './queue.ts'

export interface ReviewDeps {
  queue: PendingQueue
  client(): Promise<Mem0Client>
  /** Score at or above which a search hit counts as "the same fact". */
  dedupeThreshold?: number
}

/** One review line: what it says and how to address it. */
function renderEntry(entry: PendingEntry): string {
  const facts = [entry.metadata.category, entry.metadata.scope, entry.metadata.importance]
    .filter((value): value is string => value !== undefined)
  const suffix = facts.length === 0 ? '' : `（${facts.join(' · ')}）`
  const evidence = entry.evidence === undefined ? '' : `\n  证据：${entry.evidence}`
  return `- [${entry.id.slice(0, 6)}] ${entry.text}${suffix} conf ${entry.confidence.toFixed(2)}${evidence}`
}

/**
 * Register `memory_review`.
 * @param ctx Host context.
 * @param deps Queue, client factory, and the dedupe threshold.
 */
export function registerReviewTool(ctx: Context, deps: ReviewDeps): void {
  const threshold = deps.dedupeThreshold ?? 0.8

  ctx.tools.register(defineTool({
    name: 'memory_review',
    description: '长期记忆：查看候审队列并批准或驳回候选事实。批准时先判重——命中已有记忆则取代它，否则保真新增。侧边栏待审页不可用时的替代入口。',
    parameters: {
      action: { type: 'string', required: true, description: 'list | approve | dismiss' },
      id: { type: 'string', description: 'approve / dismiss 的条目 id（memory_review list 返回的完整 id 或其前几位）。' },
      note: { type: 'string', description: '可选备注，作为 decided_by 记入条目。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => false,
    async execute(args) {
      const entries = await deps.queue.list()
      const lookup = (id: string): PendingEntry | undefined =>
        entries.find((entry) => entry.id === id || entry.id.startsWith(id))

      if (args.action === 'list') {
        const pending = entries.filter((entry) => entry.status === 'pending')
        if (pending.length === 0) return { text: '候审队列为空。' }
        return { text: `待审 ${pending.length} 条：\n${pending.map(renderEntry).join('\n')}` }
      }

      // Validate the verb before the argument: reporting "needs an id" for an
      // action that does not exist sends the reader down the wrong path.
      if (args.action !== 'approve' && args.action !== 'dismiss') {
        return { text: `未知 action：${args.action}（支持 list | approve | dismiss）。` }
      }
      if (args.id === undefined) return { text: `${args.action} 需要 id；先用 memory_review list 查看。` }
      const entry = lookup(args.id)
      if (entry === undefined) return { text: `没有找到候审条目 ${args.id}。` }

      const decidedBy = args.note
      if (args.action === 'dismiss') {
        await deps.queue.decide(entry.id, 'dismissed', decidedBy === undefined ? {} : { decidedBy })
        return { text: `已驳回：${entry.text}` }
      }

      const client = await deps.client()
      const hits = await client.recall({ query: entry.text, topK: 3 })
      const best = hits[0]
      const decision = decidedBy === undefined ? {} : { decidedBy }

      if (best !== undefined && (best.score ?? 0) >= threshold) {
        const result = await client.supersede({ oldId: best.id, text: entry.text, metadata: entry.metadata })
        const created = result.created[0]
        await deps.queue.decide(entry.id, 'approved', {
          supersedes: result.supersededId,
          ...created === undefined ? {} : { storedMemoryId: created.id },
          ...decision,
        })
        return { text: `已批准并取代 ${result.supersededId.slice(0, 8)}：${entry.text}` }
      }

      const created = await client.remember({ text: entry.text, metadata: entry.metadata, infer: false })
      const stored = created[0]
      await deps.queue.decide(entry.id, 'approved', {
        ...stored === undefined ? {} : { storedMemoryId: stored.id },
        ...decision,
      })
      return {
        text: stored === undefined
          ? `已批准并写入：${entry.text}`
          : `已批准并写入 ${stored.id.slice(0, 8)}：${entry.text}`,
      }
    },
  }))
}
