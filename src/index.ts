/**
 * dsh-memory core — the `memory_*` tool surface and the skill rules.
 *
 * One of five independently toggleable components in this bundle (core tools,
 * recall injection, capture, review, debug). This one owns what the model
 * calls directly: the six memory tools and the skill that teaches when to use
 * them. Every mem0 call is fail-open — a memory service that is down degrades
 * this component to a no-op; it never fails a session.
 * @module dsh-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { activeBootReporter } from './boot.ts'
import { sharedTracer } from './debug.ts'
import { createQueue } from './queue.ts'
import { registerSkill } from './skill.ts'
import { registerMemoryTools } from './tools.ts'
import { queueEventTrace, resolvePendingDir } from './runtime.ts'
import { makeClientFactory } from './runtime.ts'

export { resolveDshHome } from './runtime.ts'

export const name = 'memory'

/** The tool runtime is the one capability this plugin cannot work without. */
export const inject = ['tools']

/** Deployment-varying values; the API key is never one of them. */
export interface Config {
  /** mem0 base URL; empty falls back to the `MEM0_BASE_URL` credential. */
  baseUrl?: string
  /** Memory owner id; empty falls back to the `MEM0_USER_ID` credential. */
  userId?: string
  /** Pending-queue directory; empty means `$DSH_HOME/memory-pending` (keep in step with the capture and review components). */
  pendingDir?: string
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().default(''),
  userId: z.string().default(''),
  pendingDir: z.string().default(''),
})

/**
 * Mount the core component: tools + skill.
 * @param ctx Host context; registrations are effects scoped to it.
 * @param config Resolved component configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // Credentials resolve per call, so a rotated key reaches the next operation.
  const client = makeClientFactory(ctx, config)
  // The queue routes `memory_remember` through human approval instead of
  // writing mem0 directly; the directory is shared with capture/review, and
  // the cross-instance lock lives in the queue module.
  const queue = createQueue({ dir: resolvePendingDir(config), onEvent: queueEventTrace })

  const toolCount = registerMemoryTools(ctx, { client, tracer: sharedTracer, queue })
  const skillResult = registerSkill(ctx, 'dsh-memory')

  // The boot reporter exists only while the debug component is enabled; without
  // it a healthy boot is silent, and registration failures already surfaced
  // through their own logger paths.
  const boot = activeBootReporter()
  boot?.report('tools', 'ok', `${toolCount} 个记忆工具已注册`)
  boot?.report('skill', skillResult.state, skillResult.detail)
}
