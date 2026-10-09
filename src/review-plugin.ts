/**
 * Review component — the queue's two doors and the queue itself.
 *
 * One of five independently toggleable components. It owns the pending queue
 * from the consuming side: the `memory_review` tool and the sidebar route both
 * open decisions through `decisions.ts`, so a human approval always runs the
 * same order (dedupe → supersede or faithful write → record). The queue
 * instance shares its directory with the capture component; the per-directory
 * write lock in `queue.ts` keeps both honest.
 * @module dsh-memory/review
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { activeBootReporter } from './boot.ts'
import { sharedTracer } from './debug.ts'
import type { DecisionDeps } from './decisions.ts'
import { registerPendingRoute } from './route.ts'
import { registerReviewTool } from './review.ts'
import { createQueue } from './queue.ts'
import { makeClientFactory, queueEventTrace, resolvePendingDir } from './runtime.ts'

export const name = 'memory-review'

/** The tool runtime is the one capability this component cannot work without. */
export const inject = ['tools']

export interface Config {
  /** mem0 base URL; empty falls back to the `MEM0_BASE_URL` credential. */
  baseUrl?: string
  /** Memory owner id; empty falls back to the `MEM0_USER_ID` credential. */
  userId?: string
  /** Pending-queue directory; empty means `$DSH_HOME/memory-pending` (keep in step with the capture component). */
  pendingDir?: string
  /** Search score at or above which an approval supersedes the existing memory. */
  dedupeThreshold?: number
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().default(''),
  userId: z.string().default(''),
  pendingDir: z.string().default(''),
  dedupeThreshold: z.number().default(0.8),
})

/**
 * Mount the review component.
 * @param ctx Host context; registrations are effects scoped to it.
 * @param config Resolved component configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const pendingDir = resolvePendingDir(config)
  const queue = createQueue({ dir: pendingDir, onEvent: queueEventTrace })
  const client = makeClientFactory(ctx, config)
  const deps: DecisionDeps = {
    queue,
    client,
    ...config.dedupeThreshold === undefined ? {} : { dedupeThreshold: config.dedupeThreshold },
    tracer: sharedTracer,
  }

  registerReviewTool(ctx, deps)
  // The sidebar tab reads and writes the same queue through this route; a host
  // without a webServer simply never gets it.
  const routeResult = registerPendingRoute(ctx, deps)

  const boot = activeBootReporter()
  boot?.report('review', 'ok', 'memory_review 工具已注册')
  boot?.report('route', routeResult.state, routeResult.detail)
}
