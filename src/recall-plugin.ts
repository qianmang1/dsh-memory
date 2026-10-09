/**
 * Recall component — context injection at session start and per step.
 *
 * One of five independently toggleable components. Two hooks, both fail-open:
 * - `agent/created` injects a brief (who this user is, within a budget).
 * - `agent/pre-step` injects recall for this prompt; it delegates with
 *   `next()` immediately rather than waiting on the network, because a slow
 *   memory service must not delay a step.
 * @module dsh-memory/recall
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { activeBootReporter } from './boot.ts'
import { buildBrief } from './brief.ts'
import { sharedTracer } from './debug.ts'
import { renderBriefInjection, renderRecallInjection } from './recall.ts'
import { errorText, injectContext, makeClientFactory, textOfBlocks } from './runtime.ts'

export const name = 'memory-recall'

/** Character budgets, fixed by the design. */
const BRIEF_BUDGET = 1200
const RECALL_BUDGET = 600
const RECALL_TOP_K = 3
const BRIEF_TOP_K = 200

export interface Config {
  /** mem0 base URL; empty falls back to the `MEM0_BASE_URL` credential. */
  baseUrl?: string
  /** Memory owner id; empty falls back to the `MEM0_USER_ID` credential. */
  userId?: string
  /** Inject a brief when an agent is created. */
  brief?: boolean
  /** Inject recall hits before each step. */
  recall?: boolean
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().default(''),
  userId: z.string().default(''),
  brief: z.boolean().default(true),
  recall: z.boolean().default(true),
})

/**
 * Mount the recall component.
 * @param ctx Host context; hook registrations are effects scoped to it.
 * @param config Resolved component configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const client = makeClientFactory(ctx, config)

  if (config.brief !== false) {
    ctx.on('agent/created', async ({ agent, signal }) => {
      try {
        const rows = await (await client()).inventory({ topK: BRIEF_TOP_K })
        if (signal?.aborted === true) {
          sharedTracer.log('debug', 'hook', 'brief.aborted')
          return
        }
        const text = renderBriefInjection(buildBrief(rows, { maxChars: BRIEF_BUDGET }))
        if (text !== undefined) {
          injectContext(agent, text)
          sharedTracer.log('info', 'hook', 'brief.done', { rows, chars: text.length, injected: true })
        } else {
          sharedTracer.log('info', 'hook', 'brief.done', { rows, injected: false, reason: 'empty' })
        }
      } catch (error) {
        sharedTracer.log('warn', 'hook', 'brief.error', { error: errorText(error).slice(0, 200) })
      }
    })
  }

  if (config.recall !== false) {
    ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
      const texts = messages.flatMap((message) => textOfBlocks(message.content))
      const query = texts.join('\n').trim().slice(0, 500)
      if (query.length > 0) {
        // Detached on purpose: the step proceeds now, and a slow or failing
        // memory service never delays it.
        void (async () => {
          try {
            const rows = await (await client()).recall({ query, topK: RECALL_TOP_K })
            if (signal?.aborted === true) {
              sharedTracer.log('debug', 'hook', 'recall.aborted')
              return
            }
            const text = renderRecallInjection(rows, { searchChars: RECALL_BUDGET })
            if (text !== undefined) {
              injectContext(agent, text)
              sharedTracer.log('info', 'hook', 'recall.done', { rows, chars: text.length, injected: true })
            } else {
              sharedTracer.log('info', 'hook', 'recall.done', { rows, injected: false, reason: 'empty' })
            }
          } catch (error) {
            sharedTracer.log('warn', 'hook', 'recall.error', { error: errorText(error).slice(0, 200) })
          }
        })()
      } else {
        sharedTracer.log('debug', 'hook', 'recall.skip', { reason: 'empty-query' })
      }
      return next()
    })
  }

  activeBootReporter()?.report('recall', 'ok', `brief=${config.brief !== false} recall=${config.recall !== false}`)
}
