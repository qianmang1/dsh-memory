/**
 * dsh-memory — 长期记忆插件的 host 入口。
 *
 * 记忆本体在自托管 mem0 上；本插件只做四件事：把 mem0 的能力暴露成 DSH 工具、
 * 在 SessionStart 注入记忆摘要（自动召回）、在 Stop 把本轮候选事实写进候审队列、
 * 把记忆管理规则注册成技能。
 *
 * 写入永不自动落库：候审队列是 `pendingDir` 下的文件，批准后才调 mem0。
 * 这是刻意的——库被批量导入污染过一次（107 条冗余），自动写入必须留在人工闸门后面。
 * @module dsh-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

export const name = 'memory'

/** Deployment-varying values; the API key is never one of them (it comes from `ctx.credentials`). */
export interface Config {
  /** mem0 service base URL; empty falls back to the `MEM0_BASE_URL` credential. */
  baseUrl?: string
  /** Memory owner id; empty falls back to the `MEM0_USER_ID` credential. */
  userId?: string
  /** Pending-review queue directory; empty means `$DSH_HOME/memory-pending`. */
  pendingDir?: string
  /** Inject a memory brief at SessionStart (automatic recall). */
  recall?: boolean
  /** Write this turn's candidate facts into the pending queue at Stop (never straight into mem0). */
  capture?: boolean
  /** Days an unhandled pending item survives before it is archived. */
  pendingTtlDays?: number
}

export const Config: z<Config> = z.object({
  baseUrl: z.string().default(''),
  userId: z.string().default(''),
  pendingDir: z.string().default(''),
  recall: z.boolean().default(true),
  capture: z.boolean().default(true),
  pendingTtlDays: z.number().default(7),
})

/** Mount the memory plugin.
 * @param ctx Host context the plugin registers into.
 * @param config Resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // Implementation lands in the next step: the tool surface, the SessionStart
  // recall hook, the Stop capture hook, and the skill registration. The config
  // contract and bundle wiring are what this scaffold exists to pin down.
  ctx.logger?.info?.(
    `dsh-memory: mounted (scaffold) — recall=${String(config.recall)} capture=${String(config.capture)} ttl=${String(config.pendingTtlDays)}d`,
  )
}
