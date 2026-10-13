/**
 * Recall component — context injection at agent creation.
 *
 * One of five independently toggleable components. One hook, fail-open:
 * - `agent/created` injects a brief (who this user is, within a budget).
 *
 * There is deliberately no per-step injection. The removed `agent/pre-step`
 * hook injected a user-role message before every step, and that message became
 * the next step's input: the step had nothing but injected memory to answer,
 * its own answer became the following step's recall query, and the cycle
 * repeated until the model ran out of things to say. One measured session:
 * 67 injections across 65 steps, 3 distinct texts, 13 text-only steps. A
 * single injection per agent cannot feed itself, so the brief stays. See
 * `.agents/notes/implemented/bug-fix/2026-10-11-recall-injection-self-sustaining-loop.md`.
 * @module dsh-memory/recall
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { activeBootReporter } from './boot.ts'
import { buildBrief } from './brief.ts'
import { sharedTracer } from './debug.ts'
import { renderBriefInjection } from './recall.ts'
import { errorText, injectContext, makeClientFactory } from './runtime.ts'

export const name = 'memory-recall'

/** Character budget, fixed by the design. */
const BRIEF_BUDGET = 1200
const BRIEF_TOP_K = 200

export interface Config {
  /** mem0 base URL; empty falls back to the `MEM0_BASE_URL` credential. */
  baseUrl?: string
  /** Memory owner id; empty falls back to the `MEM0_USER_ID` credential. */
  userId?: string
  /** Inject a brief when an agent is created. */
  brief?: boolean
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().default(''),
  userId: z.string().default(''),
  brief: z.boolean().default(true),
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

  activeBootReporter()?.report('recall', 'ok', `brief=${config.brief !== false}`)
}
