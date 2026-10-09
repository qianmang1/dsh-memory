/**
 * Component runtime seams — what the split plugins share.
 *
 * The bundle ships five independently toggleable cordis entries (core tools,
 * recall injection, capture, review, debug). They run in one host process but
 * mount as separate plugins, so anything more than one component needs — the
 * message source, the client factory, the pending directory — lives here as a
 * pure helper instead of a closure inside one `apply`.
 * @module dsh-memory/runtime
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type ContentBlock, type ContextFormed } from '@deepseek-ai/dsh-llm'
import { sharedTracer } from './debug.ts'
import { resolveMem0Credentials } from './credentials.ts'
import { createMem0Client, type Mem0Client } from './mem0.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-memory': { kind: 'dsh-memory' } & ContextFormed
  }
}

/** Provenance marker on every message this bundle injects. */
export const CONTEXT_SOURCE = { kind: 'dsh-memory' } as const

/** `$DSH_HOME` when set, else `~/.dsh` — the same anchor the harness home uses. */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['DSH_HOME']
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : join(homedir(), '.dsh')
}

/** The pending-queue directory: an explicit override, else `$DSH_HOME/memory-pending`. */
export function resolvePendingDir(config: { pendingDir?: string }): string {
  return config.pendingDir?.trim() || join(resolveDshHome(), 'memory-pending')
}

/** Text blocks of one message, so hooks never see a content union. */
export function textOfBlocks(blocks: readonly ContentBlock[]): string[] {
  return blocks.filter((block) => block.type === 'text').map((block) => (block as { text: string }).text)
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The log levels the host logger may offer; every one is optional. */
export interface OptionalLogger {
  debug?(message: string): unknown
  info?(message: string): unknown
  warn?(message: string): unknown
  error?(message: string): unknown
}

/** Read the host logger off a context, tolerating its absence in tests. */
export function hostLogger(ctx: Context): OptionalLogger | undefined {
  return (ctx as { logger?: OptionalLogger }).logger
}

/** Hand one injected context message to an agent. */
export function injectContext(agent: { inject(message: ReturnType<typeof createUserMessage>): void }, text: string): void {
  agent.inject(createUserMessage({ content: [{ type: 'text', text }], source: CONTEXT_SOURCE }))
}

/**
 * Build the client factory one component uses. Credentials resolve per call,
 * so a rotated key reaches the next operation; failures trace through the
 * shared (gated) ring like every other event.
 */
export function makeClientFactory(ctx: Context, config: { baseUrl?: string; userId?: string }): () => Promise<Mem0Client> {
  return async (): Promise<Mem0Client> => createMem0Client({
    ...(await resolveMem0Credentials(ctx, config)),
    onEvent: (event, detail) => sharedTracer.log(event.endsWith('_error') ? 'warn' : 'debug', 'mem0', event, detail),
  })
}

/** The queue event seam every component's queue instance shares. */
export function queueEventTrace(event: string, detail?: Record<string, unknown>): void {
  sharedTracer.log(event.startsWith('decide') ? 'info' : 'debug', 'queue', event, detail)
}
