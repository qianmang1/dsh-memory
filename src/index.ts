/**
 * dsh-memory — the host entry that wires the layers together.
 *
 * Three lifecycle points, each with a job that must not block or fail the turn:
 * - `agent/created` injects a brief (who this user is, within a budget).
 * - `agent/pre-step` injects recall for this prompt and remembers the turn's
 *   text; it delegates with `next()` immediately rather than waiting on the
 *   network, because a slow memory service must not delay a step.
 * - `agent/turn-stopping` turns the turn's text into review candidates. It never
 *   writes to mem0: approval is a separate, human act.
 *
 * Every mem0 call is fail-open. A memory service that is down degrades this
 * plugin to a no-op; it never fails a session.
 * @module dsh-memory
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type ContentBlock, type ContextFormed } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { buildBrief } from './brief.ts'
import { extractCandidates } from './capture.ts'
import { resolveMem0Credentials } from './credentials.ts'
import { createMem0Client, type Mem0Client } from './mem0.ts'
import { createQueue } from './queue.ts'
import { renderBriefInjection, renderRecallInjection } from './recall.ts'
import { registerPendingRoute } from './route.ts'
import { registerReviewTool } from './review.ts'
import { registerSkill } from './skill.ts'
import { registerMemoryTools } from './tools.ts'

export const name = 'memory'

/** The tool runtime is the one capability this plugin cannot work without. */
export const inject = ['tools']

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-memory': { kind: 'dsh-memory' } & ContextFormed
  }
}

const CONTEXT_SOURCE = { kind: 'dsh-memory' } as const

/** Character budgets, fixed by the design. */
const BRIEF_BUDGET = 1200
const RECALL_BUDGET = 600
const RECALL_TOP_K = 3
const BRIEF_TOP_K = 200

/** Deployment-varying values; the API key is never one of them. */
export interface Config {
  /** mem0 base URL; empty falls back to the `MEM0_BASE_URL` credential. */
  baseUrl?: string
  /** Memory owner id; empty falls back to the `MEM0_USER_ID` credential. */
  userId?: string
  /** Pending-queue directory; empty means `$DSH_HOME/memory-pending`. */
  pendingDir?: string
  /** Inject a brief at SessionStart. */
  recall?: boolean
  /** Write this turn's candidates into the review queue at Stop. */
  capture?: boolean
  /** Days an unhandled candidate survives before it is archived. */
  pendingTtlDays?: number
  /** Minimum candidate score; matches the design's 0.6. */
  captureThreshold?: number
  /** Candidates per turn, at most. */
  maxPerTurn?: number
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().default(''),
  userId: z.string().default(''),
  pendingDir: z.string().default(''),
  recall: z.boolean().default(true),
  capture: z.boolean().default(true),
  pendingTtlDays: z.number().default(7),
  captureThreshold: z.number().default(0.6),
  maxPerTurn: z.number().default(5),
})

/** `$DSH_HOME` when set, else `~/.dsh` — the same anchor the harness home uses. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['DSH_HOME']
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
}

/** Text blocks of one message, so hooks never see a content union. */
function textOfBlocks(blocks: readonly ContentBlock[]): string[] {
  return blocks.filter((block) => block.type === 'text').map((block) => (block as { text: string }).text)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Mount the memory plugin.
 * @param ctx Host context; registrations are effects scoped to it.
 * @param config Resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const pendingDir = config.pendingDir?.trim() || join(resolveDshHome(), 'memory-pending')
  const queue = createQueue({ dir: pendingDir, ttlDays: config.pendingTtlDays ?? 7 })
  // Credentials resolve per call, so a rotated key reaches the next operation.
  const client = async (): Promise<Mem0Client> => createMem0Client(await resolveMem0Credentials(ctx, config))

  registerMemoryTools(ctx, { client })
  registerReviewTool(ctx, { queue, client })
  registerSkill(ctx, 'dsh-memory')
  // The sidebar tab reads and writes the same queue through this route; a host
  // without a webServer simply never gets it.
  registerPendingRoute(ctx, { queue, client })

  // This turn's text, keyed by session: Stop cannot read a conversation, and the
  // pre-step payload is the one place the turn's words are handed to us.
  const turnTexts = new Map<string, string[]>()

  const injectContext = (agent: { inject(message: ReturnType<typeof createUserMessage>): void }, text: string): void => {
    agent.inject(createUserMessage({ content: [{ type: 'text', text }], source: CONTEXT_SOURCE }))
  }

  if (config.recall !== false) {
    ctx.on('agent/created', async ({ agent, signal }) => {
      try {
        const rows = await (await client()).inventory({ topK: BRIEF_TOP_K })
        if (signal?.aborted === true) return
        const text = renderBriefInjection(buildBrief(rows, { maxChars: BRIEF_BUDGET }))
        if (text !== undefined) injectContext(agent, text)
      } catch (error) {
        ctx.logger.warn(`dsh-memory: 启动召回失败（已忽略）: ${errorText(error)}`)
      }
    })
  }

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const texts = messages.flatMap((message) => textOfBlocks(message.content))
    turnTexts.set(String(agent.session.header.id), texts)

    if (config.recall !== false) {
      const query = texts.join('\n').trim().slice(0, 500)
      if (query.length > 0) {
        // Detached on purpose: the step proceeds now, and a slow or failing
        // memory service never delays it.
        void (async () => {
          try {
            const rows = await (await client()).recall({ query, topK: RECALL_TOP_K })
            if (signal?.aborted === true) return
            const text = renderRecallInjection(rows, { searchChars: RECALL_BUDGET })
            if (text !== undefined) injectContext(agent, text)
          } catch (error) {
            ctx.logger.warn(`dsh-memory: 检索注入失败（已忽略）: ${errorText(error)}`)
          }
        })()
      }
    }
    return next()
  })

  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (config.capture === false) return
    const key = String(agent.session.header.id)
    const texts = turnTexts.get(key) ?? []
    turnTexts.delete(key)
    if (texts.length === 0) return

    const candidates = extractCandidates(texts, {
      threshold: config.captureThreshold ?? 0.6,
      maxPerTurn: config.maxPerTurn ?? 5,
    })
    if (candidates.length === 0) return

    try {
      // TTL runs here rather than on a timer: the queue only matters when it is
      // being written to.
      await queue.expire()
      for (const candidate of candidates) {
        await queue.offer({
          text: candidate.text,
          confidence: candidate.confidence,
          sourceSession: key,
        })
      }
    } catch (error) {
      ctx.logger.warn(`dsh-memory: 候审入队失败（已忽略）: ${errorText(error)}`)
    }
  })
}
