/**
 * Brief rendering — the SessionStart payload and the `memory_brief` tool body.
 *
 * Pure on purpose: grouping and truncation are the parts most likely to drift
 * (a budget that is not enforced, a category silently dropped), so they are
 * testable without a context or a network.
 * @module dsh-memory/brief
 */

import type { MemoryRow } from './mem0.ts'

/** Display order and labels; an unknown category lands in the trailing group. */
const CATEGORY_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['preference', '偏好'],
  ['constraint', '约束'],
  ['goal', '目标'],
  ['decision', '决策'],
  ['workflow', '工作流'],
  ['project', '项目'],
  ['fact', '事实'],
  ['person', '人物'],
  ['relation', '关系'],
]

const OTHER_LABEL = '其它'

/** Lower sorts first inside a group. */
function importanceRank(importance: string | undefined): number {
  if (importance === 'permanent') return 0
  if (importance === 'long_term') return 1
  if (importance === 'temporary') return 2
  return 1.5
}

export interface BriefOptions {
  /** Hard cap on the rendered text, in characters. */
  maxChars?: number
  /** Include rows the service marks historical (default false). */
  includeHistorical?: boolean
}

/**
 * Render memory rows as a grouped brief, newest-and-most-important first inside
 * each group, stopping at the character budget.
 * @param rows Rows in any order; the function sorts them.
 * @param options Budget and historical inclusion.
 * @returns The brief, or an empty string when there is nothing to say.
 */
export function buildBrief(rows: readonly MemoryRow[], options: BriefOptions = {}): string {
  const maxChars = options.maxChars ?? 1200
  const usable = rows.filter((row) => options.includeHistorical === true || row.metadata.status !== 'historical')
  if (usable.length === 0 || maxChars <= 0) return ''

  const groupOrder = CATEGORY_LABELS.map(([category]) => category)
  const grouped = new Map<string, MemoryRow[]>()
  for (const row of usable) {
    const category = row.metadata.category ?? OTHER_LABEL
    const key = groupOrder.includes(category) ? category : OTHER_LABEL
    const bucket = grouped.get(key)
    if (bucket === undefined) grouped.set(key, [row])
    else bucket.push(row)
  }

  for (const bucket of grouped.values()) {
    bucket.sort((left, right) => {
      const byImportance = importanceRank(left.metadata.importance) - importanceRank(right.metadata.importance)
      if (byImportance !== 0) return byImportance
      return (right.createdAt ?? '').localeCompare(left.createdAt ?? '')
    })
  }

  const labelOf = (key: string): string =>
    key === OTHER_LABEL ? OTHER_LABEL : CATEGORY_LABELS.find(([category]) => category === key)?.[1] ?? OTHER_LABEL

  const lines: string[] = []
  let used = 0
  let truncated = false
  const keys = [...groupOrder.filter((key) => grouped.has(key)), ...grouped.has(OTHER_LABEL) ? [OTHER_LABEL] : []]

  for (const key of keys) {
    const header = `[${labelOf(key)}]`
    const entries = grouped.get(key) ?? []
    const body: string[] = []
    let headerWritten = false
    for (const row of entries) {
      const line = `- ${row.memory.trim()}`
      // The budget covers the whole rendered text, headers included.
      const pending = (headerWritten ? 0 : `${header}\n`.length) + `${line}\n`.length
      if (used + pending > maxChars) {
        truncated = true
        break
      }
      if (!headerWritten) {
        lines.push(header)
        used += `${header}\n`.length
        headerWritten = true
      }
      body.push(line)
      used += `${line}\n`.length
    }
    lines.push(...body)
    if (truncated) break
  }

  if (lines.length === 0) return ''
  const text = lines.join('\n')
  return truncated ? `${text}\n…（已达字符预算，其余省略）` : text
}
