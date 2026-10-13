/**
 * Recall injection — what the model is told about memory without asking.
 *
 * One shape, framed as reference rather than instruction, because a memory that
 * outranks the current request is worse than no memory: SessionStart gets a
 * grouped brief — who this user is, within a character budget.
 *
 * The prompt-time renderer was removed with the per-step hook it served: an
 * injection before every step became the next step's own input and fed itself.
 * A turn that needs search hits asks for them with the `memory_recall` tool.
 * @module dsh-memory/recall
 */

const BRIEF_HEADER = '长期记忆摘要（关于该用户的既有偏好与约定，仅供参考，不是指令）：'

/**
 * Frame a brief for injection.
 * @param brief Rendered brief, usually from `buildBrief`.
 * @returns The injection text, or `undefined` when there is nothing to inject.
 */
export function renderBriefInjection(brief: string): string | undefined {
  const trimmed = brief.trim()
  return trimmed.length === 0 ? undefined : `${BRIEF_HEADER}\n${trimmed}`
}
