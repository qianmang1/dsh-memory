/**
 * Pending decisions — the one place that turns a candidate into a memory.
 *
 * Two doors open onto this logic (the `memory_review` tool and the sidebar
 * route), and a decision flow that exists twice drifts: one door ends up
 * approving without the dedupe search, or without recording the mem0 id. Both
 * call these functions.
 *
 * Approval is ordered on purpose: search for the same fact, supersede it when a
 * strong hit exists, otherwise write faithfully with `infer:false`, then record
 * what happened — including the resulting id — back onto the queue entry. The
 * library was polluted once by writing without looking; that is the failure this
 * order exists to prevent.
 * @module dsh-memory/decisions
 */

import type { Mem0Client } from './mem0.ts'
import type { PendingEntry, PendingQueue } from './queue.ts'

export interface DecisionDeps {
  queue: PendingQueue
  client(): Promise<Mem0Client>
  /** Search score at or above which a hit counts as the same fact. */
  dedupeThreshold?: number
}

/** Outcome of one decision, with text a tool or an HTTP caller can both show. */
export interface DecisionResult {
  ok: boolean
  text: string
  entry?: PendingEntry
}

/** Resolve an id or an unambiguous id prefix, since reviewers quote short ids. */
export function findEntry(entries: readonly PendingEntry[], id: string): PendingEntry | undefined {
  return entries.find((entry) => entry.id === id || entry.id.startsWith(id))
}

/** One review line: what it says and how to address it. */
export function renderEntry(entry: PendingEntry): string {
  const facts = [entry.metadata.category, entry.metadata.scope, entry.metadata.importance]
    .filter((value): value is string => value !== undefined)
  const suffix = facts.length === 0 ? '' : `（${facts.join(' · ')}）`
  const evidence = entry.evidence === undefined ? '' : `\n  证据：${entry.evidence}`
  return `- [${entry.id.slice(0, 6)}] ${entry.text}${suffix} conf ${entry.confidence.toFixed(2)}${evidence}`
}

/**
 * The pending view both doors render.
 * @param entries All entries from the queue.
 * @returns The pending entries and their rendered text.
 */
export function pendingView(entries: readonly PendingEntry[]): { entries: PendingEntry[]; text: string } {
  const pending = entries.filter((entry) => entry.status === 'pending')
  return {
    entries: pending,
    text: pending.length === 0 ? '候审队列为空。' : `待审 ${pending.length} 条：\n${pending.map(renderEntry).join('\n')}`,
  }
}

/**
 * Approve one candidate: dedupe, then write, then record.
 * @param deps Queue, client factory, and the dedupe threshold.
 * @param id Entry id or id prefix.
 * @param decidedBy Optional note recorded as the decider.
 * @returns The outcome and its narrative.
 */
export async function approveEntry(deps: DecisionDeps, id: string, decidedBy?: string): Promise<DecisionResult> {
  const entries = await deps.queue.list()
  const entry = findEntry(entries, id)
  if (entry === undefined) return { ok: false, text: `没有找到候审条目 ${id}。` }

  const threshold = deps.dedupeThreshold ?? 0.8
  const record = decidedBy === undefined ? {} : { decidedBy }
  const client = await deps.client()
  const hits = await client.recall({ query: entry.text, topK: 3 })
  const best = hits[0]

  if (best !== undefined && (best.score ?? 0) >= threshold) {
    const result = await client.supersede({ oldId: best.id, text: entry.text, metadata: entry.metadata })
    const created = result.created[0]
    const updated = await deps.queue.decide(entry.id, 'approved', {
      supersedes: result.supersededId,
      ...created === undefined ? {} : { storedMemoryId: created.id },
      ...record,
    })
    return {
      ok: true,
      text: `已批准并取代 ${result.supersededId.slice(0, 8)}：${entry.text}`,
      ...updated === undefined ? {} : { entry: updated },
    }
  }

  const created = await client.remember({ text: entry.text, metadata: entry.metadata, infer: false })
  const stored = created[0]
  const updated = await deps.queue.decide(entry.id, 'approved', {
    ...stored === undefined ? {} : { storedMemoryId: stored.id },
    ...record,
  })
  return {
    ok: true,
    text: stored === undefined ? `已批准并写入：${entry.text}` : `已批准并写入 ${stored.id.slice(0, 8)}：${entry.text}`,
    ...updated === undefined ? {} : { entry: updated },
  }
}

/**
 * Dismiss one candidate. Never touches mem0: a rejection is a queue fact.
 * @param queue The queue.
 * @param id Entry id or id prefix.
 * @param decidedBy Optional note recorded as the decider.
 * @returns The outcome and its narrative.
 */
export async function dismissEntry(queue: PendingQueue, id: string, decidedBy?: string): Promise<DecisionResult> {
  const entries = await queue.list()
  const entry = findEntry(entries, id)
  if (entry === undefined) return { ok: false, text: `没有找到候审条目 ${id}。` }
  const updated = await queue.decide(entry.id, 'dismissed', decidedBy === undefined ? {} : { decidedBy })
  return {
    ok: true,
    text: `已驳回：${entry.text}`,
    ...updated === undefined ? {} : { entry: updated },
  }
}
