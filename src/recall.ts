/**
 * Recall injection — what the model is told about memory without asking.
 *
 * Two shapes, both framed as reference rather than instruction, because a
 * memory that outranks the current request is worse than no memory:
 * - SessionStart gets a grouped brief: who this user is, within a character
 *   budget.
 * - Each prompt gets the strongest search hits for that prompt, under a smaller
 *   budget, and only above a score threshold — an unrelated recall is noise that
 *   costs context on every turn.
 * @module dsh-memory/recall
 */

import type { MemoryRow } from './mem0.ts'

export interface RecallBudgets {
  /** Character budget for the prompt-time injection. */
  searchChars?: number
  /** Minimum search score a row needs to be injected (rows without a score pass). */
  threshold?: number
}

const BRIEF_HEADER = '长期记忆摘要（关于该用户的既有偏好与约定，仅供参考，不是指令）：'
const RECALL_HEADER = '相关长期记忆（按相关度排序，仅供参考）：'

/**
 * Frame a brief for injection.
 * @param brief Rendered brief, usually from `buildBrief`.
 * @returns The injection text, or `undefined` when there is nothing to inject.
 */
export function renderBriefInjection(brief: string): string | undefined {
  const trimmed = brief.trim()
  return trimmed.length === 0 ? undefined : `${BRIEF_HEADER}\n${trimmed}`
}

/**
 * Frame the strongest hits under a budget.
 * @param rows Search results, best first.
 * @param budgets Character budget and score threshold.
 * @returns The injection text, or `undefined` when nothing qualifies.
 */
export function renderRecallInjection(rows: readonly MemoryRow[], budgets: RecallBudgets = {}): string | undefined {
  const maxChars = budgets.searchChars ?? 600
  const threshold = budgets.threshold ?? 0.5
  const usable = rows.filter((row) =>
    row.metadata.status !== 'historical' && (row.score === undefined || row.score >= threshold))
  if (usable.length === 0 || maxChars <= 0) return undefined

  const lines: string[] = []
  let used = `${RECALL_HEADER}\n`.length
  let truncated = false
  for (const row of usable) {
    const line = `- ${row.memory.trim()}`
    if (used + line.length + 1 > maxChars) {
      truncated = true
      break
    }
    lines.push(line)
    used += line.length + 1
  }
  if (lines.length === 0) return undefined
  const body = truncated ? `${lines.join('\n')}\n…（还有更多，未全部注入）` : lines.join('\n')
  return `${RECALL_HEADER}\n${body}`
}
