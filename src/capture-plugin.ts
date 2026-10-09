/**
 * Capture component — the turn's text becomes review candidates at Stop.
 *
 * One of five independently toggleable components. It records each step's text
 * in its own pre-step listener (so enabling capture never depended on the
 * recall component's hooks) and turns it into queue candidates when the turn
 * stops. It never writes to mem0: approval is a separate, human act.
 * @module dsh-memory/capture
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { activeBootReporter } from './boot.ts'
import { extractCandidates } from './capture.ts'
import { sharedTracer } from './debug.ts'
import { createQueue } from './queue.ts'
import { errorText, queueEventTrace, resolvePendingDir, textOfBlocks } from './runtime.ts'

export const name = 'memory-capture'

export interface Config {
  /** Pending-queue directory; empty means `$DSH_HOME/memory-pending` (keep in step with the review component). */
  pendingDir?: string
  /** Minimum candidate score; matches the design's 0.6. */
  captureThreshold?: number
  /** Candidates per turn, at most. */
  maxPerTurn?: number
  /** Days an unhandled candidate survives before it is archived. */
  pendingTtlDays?: number
}

export const Config: z<Config> = z.object({
  pendingDir: z.string().default(''),
  captureThreshold: z.number().default(0.6),
  maxPerTurn: z.number().default(5),
  pendingTtlDays: z.number().default(7),
})

/**
 * Mount the capture component.
 * @param ctx Host context; hook registrations are effects scoped to it.
 * @param config Resolved component configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const pendingDir = resolvePendingDir(config)
  const ttlDays = config.pendingTtlDays ?? 7
  const threshold = config.captureThreshold ?? 0.6
  const maxPerTurn = config.maxPerTurn ?? 5
  const queue = createQueue({ dir: pendingDir, ttlDays, onEvent: queueEventTrace })

  // This turn's text, keyed by session: Stop cannot read a conversation, and
  // the pre-step payload is the one place the turn's words are handed to us.
  const turnTexts = new Map<string, string[]>()

  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const texts = messages.flatMap((message) => textOfBlocks(message.content))
    turnTexts.set(String(agent.session.header.id), texts)
    sharedTracer.log('debug', 'hook', 'prestep.texts', {
      session: String(agent.session.header.id).slice(0, 8),
      messages: messages.length,
      chars: texts.join('').length,
    })
    return next()
  })

  ctx.on('agent/turn-stopping', async ({ agent }) => {
    const key = String(agent.session.header.id)
    const texts = turnTexts.get(key)
    turnTexts.delete(key)
    if (texts === undefined || texts.length === 0) {
      sharedTracer.log('debug', 'hook', 'capture.skip', { reason: 'no-turn-texts' })
      return
    }

    const candidates = extractCandidates(texts, { threshold, maxPerTurn })
    if (candidates.length === 0) {
      sharedTracer.log('info', 'hook', 'capture.skip', { reason: 'below-threshold', messages: texts.length })
      return
    }

    try {
      // TTL runs here rather than on a timer: the queue only matters when it is
      // being written to.
      await queue.expire()
      let offered = 0
      for (const candidate of candidates) {
        const entry = await queue.offer({
          text: candidate.text,
          confidence: candidate.confidence,
          sourceSession: key,
        })
        if (entry !== undefined) offered += 1
      }
      sharedTracer.log('info', 'hook', 'capture.done', {
        candidates: candidates.length,
        offered,
        duplicates: candidates.length - offered,
        session: key.slice(0, 8),
      })
    } catch (error) {
      sharedTracer.log('warn', 'hook', 'capture.error', { error: errorText(error).slice(0, 200) })
    }
  })

  // Config sanity belongs to the mount line: values outside their range would
  // otherwise silently change what gets captured.
  const boot = activeBootReporter()
  const warnings: string[] = []
  if (threshold < 0 || threshold > 1) warnings.push(`captureThreshold=${threshold} 超出 [0,1]`)
  if (ttlDays <= 0) warnings.push(`pendingTtlDays=${config.pendingTtlDays} 非正数，候选永不过期`)
  if (maxPerTurn < 1) warnings.push(`maxPerTurn=${maxPerTurn} 小于 1`)
  boot?.report('capture-config', warnings.length > 0 ? 'warn' : 'ok',
    `threshold=${threshold} maxPerTurn=${maxPerTurn} ttl=${ttlDays}d`
    + (warnings.length > 0 ? `；${warnings.join('；')}` : ''))
  boot?.report('capture', 'ok', `候审队列 ${pendingDir}`)
}
