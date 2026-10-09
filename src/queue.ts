/**
 * Pending-review queue — the file layer between "candidate fact" and "stored
 * memory".
 *
 * Two write paths, chosen for the failure they can have:
 * - A new candidate is **appended** as one JSONL line. Concurrent appends from
 *   several sessions interleave without losing each other, and an interrupted
 *   write leaves at most one malformed trailing line.
 * - A status change rewrites the whole file through a temp file and a rename,
 *   because the line that changes is not the line being added. That is not
 *   concurrency-safe across processes by itself, so writes are serialized per
 *   directory across every queue instance in-process, and the state machine is
 *   idempotent: a lost race costs one transition, not a corrupted queue.
 *
 * `pending.md` is a derived view, never a source: approving by editing the
 * markdown would put the decision where no read path looks.
 * @module dsh-memory/queue
 */

import { createHash, randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { OnEvent } from './debug.ts'
import type { MemoryMetadata } from './mem0.ts'

export type PendingStatus = 'pending' | 'approved' | 'dismissed' | 'expired'

/** One candidate fact awaiting a human decision. */
export interface PendingEntry {
  id: string
  /** Local dedupe key over normalized text; the service's own row hash is separate and server-side. */
  hash: string
  text: string
  metadata: MemoryMetadata
  /** Where the candidate came from, for a reviewer who has to judge it. */
  evidence?: string
  source_session?: string
  /** Heuristic score that admitted it; `< 0.6` never reaches the queue. */
  confidence: number
  /** Filled by the approval flow when this fact replaces an existing memory. */
  supersedes?: string
  created_at: string
  status: PendingStatus
  decided_at?: string
  decided_by?: string
  /** mem0 id written on approval; its presence is what makes the decision auditable. */
  stored_memory_id?: string
}

export interface OfferInput {
  text: string
  metadata?: MemoryMetadata
  evidence?: string
  sourceSession?: string
  confidence: number
}

export interface DecideOptions {
  storedMemoryId?: string
  supersedes?: string
  decidedBy?: string
}

export interface PendingQueue {
  /** Append a candidate unless its normalized text is already known (any status). */
  offer(input: OfferInput): Promise<PendingEntry | undefined>
  /** All entries, in file order. */
  list(): Promise<PendingEntry[]>
  /** Move every overdue `pending` entry to `expired` and archive it. Returns how many moved. */
  expire(): Promise<number>
  /** Set one entry's decision; returns the updated entry, or undefined when the id is unknown. */
  decide(id: string, status: 'approved' | 'dismissed', options?: DecideOptions): Promise<PendingEntry | undefined>
  /** Regenerate `pending.md` from the JSONL source. */
  render(): Promise<string>
  /** Files this queue owns; exposed for the review route and for tests. */
  paths(): { jsonl: string; markdown: string; archive: string }
}

/** Normalize text for dedupe: case, whitespace, and punctuation all stop mattering. */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** Local dedupe key; deliberately not the service's hash, which is computed server-side. */
export function hashText(text: string): string {
  return createHash('sha256').update(normalizeText(text)).digest('hex').slice(0, 32)
}

const TERMINAL_LABELS: Record<Exclude<PendingStatus, 'pending'>, string> = {
  approved: '已批准',
  dismissed: '已驳回',
  expired: '已过期',
}

/** Render the derived markdown view; ids are shortened for human reference only. */
export function renderMarkdown(entries: readonly PendingEntry[]): string {
  const sections: Array<[string, PendingStatus]> = [
    ['待审', 'pending'],
    ['已批准', 'approved'],
    ['已驳回', 'dismissed'],
    ['已过期', 'expired'],
  ]
  const lines: string[] = ['# 记忆候审队列', '', '> 由 pending.jsonl 生成，勿手工编辑；批准与驳回在侧边栏或 memory_review 里做。', '']
  for (const [title, status] of sections) {
    const rows = entries.filter((entry) => entry.status === status)
    if (rows.length === 0) continue
    lines.push(`## ${title} ${rows.length}`, '')
    for (const entry of rows) {
      const facts = [entry.metadata.category, entry.metadata.scope, entry.metadata.importance]
        .filter((value): value is string => value !== undefined)
      const suffix = facts.length === 0 ? '' : `（${facts.join(' · ')}）`
      lines.push(`- [${entry.id.slice(0, 6)}] ${entry.text}${suffix} conf ${entry.confidence.toFixed(2)}`)
      const detail = [
        entry.evidence === undefined ? undefined : `证据：${entry.evidence}`,
        `时间：${entry.created_at}`,
        entry.supersedes === undefined ? undefined : `取代：${entry.supersedes.slice(0, 8)}`,
        entry.stored_memory_id === undefined ? undefined : `mem0：${entry.stored_memory_id.slice(0, 8)}`,
      ].filter((value): value is string => value !== undefined)
      if (detail.length > 0) lines.push(`  ${detail.join(' · ')}`)
    }
    lines.push('')
  }
  if (entries.length === 0) lines.push('（队列为空）', '')
  return lines.join('\n')
}

/** Parse the JSONL source, dropping a malformed line rather than failing the read. */
export function parseEntries(text: string): PendingEntry[] {
  const entries: PendingEntry[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      const parsed = JSON.parse(trimmed) as PendingEntry
      if (typeof parsed.id === 'string' && typeof parsed.text === 'string') entries.push(parsed)
    } catch {
      // A torn trailing line from an interrupted append is expected, not fatal.
    }
  }
  return entries
}

/**
 * Build the queue over one directory.
 * @param options Directory, TTL, a clock seam for tests, and an event seam for tracing.
 * @returns The queue.
 */
export function createQueue(options: { dir: string; ttlDays?: number; now?: () => Date; onEvent?: OnEvent }): PendingQueue {
  const ttlDays = options.ttlDays ?? 7
  const now = options.now ?? (() => new Date())
  const emit = options.onEvent
  const jsonl = join(options.dir, 'pending.jsonl')
  const markdown = join(options.dir, 'pending.md')
  const archive = join(options.dir, 'archive.jsonl')

  const readAll = async (): Promise<PendingEntry[]> => {
    try {
      return parseEntries(await readFile(jsonl, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  const writeAll = async (entries: readonly PendingEntry[]): Promise<void> => {
    const body = entries.map((entry) => JSON.stringify(entry)).join('\n')
    const temp = `${jsonl}.tmp-${randomUUID()}`
    await writeFile(temp, body.length === 0 ? '' : `${body}\n`, 'utf8')
    await rename(temp, jsonl)
  }

  const refreshView = async (entries: readonly PendingEntry[]): Promise<string> => {
    const text = renderMarkdown(entries)
    const temp = `${markdown}.tmp-${randomUUID()}`
    await writeFile(temp, text, 'utf8')
    await rename(temp, markdown)
    return text
  }

  const isOverdue = (entry: PendingEntry): boolean => {
    const created = Date.parse(entry.created_at)
    if (Number.isNaN(created)) return false
    return now().getTime() - created > ttlDays * 24 * 60 * 60 * 1000
  }

  return {
    paths: () => ({ jsonl, markdown, archive }),

    async offer(input) {
      const text = input.text.trim()
      if (text.length === 0) {
        emit?.('offer_skip', { reason: 'empty' })
        return undefined
      }
      const hash = hashText(text)
      return withDirLock(options.dir, async () => {
        await mkdir(options.dir, { recursive: true })
        // Dedupe across every status: a rejected candidate must not come back
        // every turn, and an approved one is already in mem0.
        const existing = await readAll()
        if (existing.some((entry) => entry.hash === hash)) {
          emit?.('offer_duplicate', { confidence: input.confidence, textChars: text.length })
          return undefined
        }
        const entry: PendingEntry = {
          id: randomUUID(),
          hash,
          text,
          metadata: input.metadata ?? {},
          confidence: input.confidence,
          created_at: now().toISOString(),
          status: 'pending',
          ...input.evidence === undefined ? {} : { evidence: input.evidence },
          ...input.sourceSession === undefined ? {} : { source_session: input.sourceSession },
        }
        await appendFile(jsonl, `${JSON.stringify(entry)}\n`, 'utf8')
        await refreshView([...existing, entry])
        emit?.('offer', { id: entry.id.slice(0, 8), confidence: entry.confidence, textChars: text.length })
        return entry
      })
    },

    list: async () => readAll(),

    async expire() {
      return withDirLock(options.dir, async () => {
        const entries = await readAll()
        const due = entries.filter((entry) => entry.status === 'pending' && isOverdue(entry))
        if (due.length === 0) return 0
        const stamp = now().toISOString()
        const updated = entries.map((entry) => due.some((row) => row.id === entry.id)
          ? { ...entry, status: 'expired' as const, decided_at: stamp, decided_by: 'ttl' }
          : entry)
        await mkdir(options.dir, { recursive: true })
        await appendFile(archive, `${due.map((entry) => JSON.stringify({ ...entry, status: 'expired', decided_at: stamp })).join('\n')}\n`, 'utf8')
        await writeAll(updated)
        await refreshView(updated)
        emit?.('expire', { count: due.length })
        return due.length
      })
    },

    async decide(id, status, decideOptions = {}) {
      return withDirLock(options.dir, async () => {
        const entries = await readAll()
        const index = entries.findIndex((entry) => entry.id === id)
        const current = entries[index]
        if (current === undefined) {
          emit?.('decide_missing', { id: id.slice(0, 8), to: status })
          return undefined
        }
        const updated: PendingEntry = {
          ...current,
          status,
          decided_at: now().toISOString(),
          ...decideOptions.decidedBy === undefined ? { decided_by: 'human' } : { decided_by: decideOptions.decidedBy },
          ...decideOptions.storedMemoryId === undefined ? {} : { stored_memory_id: decideOptions.storedMemoryId },
          ...decideOptions.supersedes === undefined ? {} : { supersedes: decideOptions.supersedes },
        }
        const next = [...entries]
        next[index] = updated
        await writeAll(next)
        await refreshView(next)
        emit?.('decide', {
          id: updated.id.slice(0, 8),
          from: current.status,
          to: status,
          stored: updated.stored_memory_id?.slice(0, 8),
        })
        return updated
      })
    },

    async render() {
      const entries = await readAll()
      await mkdir(options.dir, { recursive: true })
      return refreshView(entries)
    },
  }
}

/** Human-readable label for a terminal status, used by the review surface. */
export function statusLabel(status: PendingStatus): string {
  return status === 'pending' ? '待审' : TERMINAL_LABELS[status]
}

/**
 * Cross-instance serialization, keyed by directory. Since the component split,
 * the capture plugin and the review plugin each build their own queue over the
 * same directory, so the lock lives at module level: concurrent writes from
 * any instance take their turn before they read the snapshot.
 */
const dirChains = new Map<string, Promise<unknown>>()
function withDirLock<T>(dir: string, task: () => Promise<T>): Promise<T> {
  const key = process.platform === 'win32' ? dir.toLowerCase() : dir
  const previous = dirChains.get(key) ?? Promise.resolve()
  const next = previous.then(task, task)
  dirChains.set(key, next.then(() => undefined, () => undefined))
  return next
}
