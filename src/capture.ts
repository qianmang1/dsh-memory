/**
 * Candidate extraction — the Stop-time gate between a turn's text and the
 * review queue.
 *
 * Deliberately a pure function over strings: what the hook can read from the
 * harness changes with the harness, but the admission rules should not. Every
 * score is a sum of named, inspectable signals, so a surprising candidate can be
 * explained ("it matched the fact vocabulary and had a subject") instead of
 * argued about.
 *
 * The rules exist to keep the queue small: the library was once polluted by a
 * single bulk import, and an auto-capture path that admits everything would
 * rebuild that failure continuously.
 * @module dsh-memory/capture
 */

/** One admitted candidate and the score that admitted it. */
export interface Candidate {
  text: string
  confidence: number
}

export interface CaptureOptions {
  /** Minimum score to admit; the design fixes this at 0.6. */
  threshold?: number
  /** Cap per turn; the design fixes this at 5. */
  maxPerTurn?: number
  /** Longest sentence considered; beyond this the text is prose, not a fact. */
  maxChars?: number
}

/** Questions never carry a fact worth storing; politeness never does either. */
const QUESTION_MARKERS = /[?？]|吗[。！!]?$|呢[。！!]?$/

/** Openers that mean "this turn contained no assertion". */
const PLEASANTRY = /^(好的|好|嗯|谢谢|多谢|收到|明白|明白了|了解|了解啦|ok|okay|thanks|thank you)[。！!,.，\s]*$/i

/** Vocabulary that distinguishes a durable fact from a task instruction. */
const FACT_VOCABULARY = /(偏好|喜欢|要求|希望|反对|必须|不要|禁止|习惯|总是|从不|约定|决定|采用|选择|使用|安装|部署|配置|规则|策略|原则|标准|术语|命名)/

/** A subject makes the sentence about someone's standing state, not about this turn. */
const SUBJECT = /(我|用户|我们|团队|项目|你)/

/** Evidence that the text is tool output or code rather than a statement. */
const CODE_OR_PATH = /(```|^\s*[$>#]\s|\/[\w.-]+\/[\w.-]+|[A-Za-z]:\\|\.(ts|tsx|js|mjs|json|yaml|yml|md|py|rs)\b)/

/** Split a message into sentence-ish units on newlines and CJK/Latin terminators. */
export function splitSentences(text: string): string[] {
  return text
    .split(/[\n\r]+|(?<=[。！!？?；;])/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}

/**
 * Score one sentence as a storable fact.
 * @param sentence Candidate sentence.
 * @returns Confidence in `[0, 1]`; the design's admission threshold is 0.6.
 */
export function scoreCandidate(sentence: string): number {
  const text = sentence.trim()
  if (text.length === 0) return 0
  if (PLEASANTRY.test(text)) return 0.05
  if (QUESTION_MARKERS.test(text)) return 0.15
  if (text.includes('```')) return 0.1

  let score = 0
  // A short declarative sentence is the shape of a fact; everything else is
  // length noise either way.
  if (text.length >= 10 && text.length <= 120) score += 0.2
  if (text.length < 8) score -= 0.3
  if (text.length > 200) score -= 0.1
  if (SUBJECT.test(text)) score += 0.2
  if (FACT_VOCABULARY.test(text)) score += 0.25
  if (CODE_OR_PATH.test(text)) score -= 0.25
  // A trailing period or none at all reads as a statement; an exclamation is emphasis.
  if (/[。.]$/.test(text) || !/[！!]$/.test(text)) score += 0.15
  if (/[！!]$/.test(text)) score -= 0.05

  return Math.max(0, Math.min(1, Number(score.toFixed(2))))
}

/**
 * Admit the storable sentences from one turn.
 * @param texts Message texts for the turn (user text first is conventional).
 * @param options Threshold, per-turn cap, and the longest sentence considered.
 * @returns Candidates ordered by score, deduplicated on normalized text.
 */
export function extractCandidates(texts: readonly string[], options: CaptureOptions = {}): Candidate[] {
  const threshold = options.threshold ?? 0.6
  const maxPerTurn = options.maxPerTurn ?? 5
  const maxChars = options.maxChars ?? 200

  const seen = new Set<string>()
  const admitted: Candidate[] = []
  for (const text of texts) {
    for (const sentence of splitSentences(text)) {
      if (sentence.length > maxChars) continue
      const confidence = scoreCandidate(sentence)
      if (confidence < threshold) continue
      const key = sentence.replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase()
      if (key.length === 0 || seen.has(key)) continue
      seen.add(key)
      admitted.push({ text: sentence, confidence })
    }
  }
  return admitted.sort((left, right) => right.confidence - left.confidence).slice(0, maxPerTurn)
}
