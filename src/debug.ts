/**
 * Debug trace — the observability layer for agent-driven testing.
 *
 * The pain this exists for: hooks, HTTP calls, and queue transitions used to be
 * silent, so testing through the agent meant guessing. Every interesting event
 * now lands in an in-memory ring (always on, bounded, cheap) that the
 * `memory_debug` tool can read, and — when explicitly enabled — in an NDJSON
 * file under `$DSH_HOME/logs/` for cross-session post-mortems.
 *
 * Redaction is defence in depth, not decoration: log points are designed to
 * carry scalars (ids, counts, statuses, timings) and never bodies, but a
 * sanitizer still walks every detail so a sensitive-looking key or an
 * over-long string cannot reach the sink.
 * @module dsh-memory/debug
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export type TraceLevel = 'debug' | 'info' | 'warn' | 'error'

/** One runtime event; `detail` is sanitized before it is stored or written. */
export interface TraceEvent {
  ts: string
  level: TraceLevel
  /** Coarse origin: hook | mem0 | queue | tool | decision | apply. */
  op: string
  /** Event name within the origin, e.g. `recall.done`. */
  event: string
  detail?: Record<string, unknown>
}

/** The event callback seam passed into the mem0 client, the queue, and decisions. */
export type OnEvent = (event: string, detail?: Record<string, unknown>) => void

const RING_DEFAULT = 300
const STRING_LIMIT = 240
const SENSITIVE_KEY = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential/i

/** Walk a detail object: scrub sensitive keys, bound strings and breadth. */
function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth]'
  if (typeof value === 'string') {
    return value.length > STRING_LIMIT ? `${value.slice(0, STRING_LIMIT)}…(+${value.length - STRING_LIMIT})` : value
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value
  if (value === undefined) return undefined
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item, depth + 1))
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitize(item, depth + 1)
    }
    return out
  }
  return String(value)
}

/** The trace surface handed to call sites and the debug tool. */
export interface Tracer {
  log(level: TraceLevel, op: string, event: string, detail?: Record<string, unknown>): void
  recent(options?: { limit?: number; level?: TraceLevel; op?: string }): TraceEvent[]
  file(): string | undefined
}

export interface TracerOptions {
  /** NDJSON sink path; undefined keeps events memory-only. */
  file?: string
  /** Ring capacity; the oldest event is dropped first. */
  capacity?: number
}

/**
 * Build the tracer. The ring is always on; the file sink is opt-in and fails
 * silently — a broken debug sink must never break the plugin.
 */
export function createTracer(options: TracerOptions = {}): Tracer {
  const capacity = options.capacity ?? RING_DEFAULT
  const ring: TraceEvent[] = []

  let sinkChain: Promise<void> = Promise.resolve()
  if (options.file !== undefined) {
    // The chain starts at the mkdir, so the first append cannot race directory creation.
    sinkChain = mkdir(dirname(options.file), { recursive: true })
      .then(() => undefined, () => undefined)
  }

  return {
    log(level, op, event, detail) {
      const traced: TraceEvent = {
        ts: new Date().toISOString(),
        level,
        op,
        event,
        ...detail === undefined ? {} : { detail: sanitize(detail) as Record<string, unknown> },
      }
      ring.push(traced)
      if (ring.length > capacity) ring.splice(0, ring.length - capacity)
      if (options.file !== undefined) {
        const file = options.file
        sinkChain = sinkChain
          .then(() => appendFile(file, `${JSON.stringify(traced)}\n`, 'utf8'))
          .catch(() => undefined)
      }
    },

    recent(query = {}) {
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 500)
      const matched = ring.filter((entry) =>
        (query.level === undefined || entry.level === query.level)
        && (query.op === undefined || entry.op === query.op))
      return matched.slice(-limit)
    },

    file: () => options.file,
  }
}

/**
 * Run one operation with start-to-end tracing, rethrowing unchanged.
 * Success detail comes from the value; failures carry the error message.
 */
export async function withTrace<T>(
  tracer: Tracer | undefined,
  op: string,
  event: string,
  run: () => Promise<T>,
  detail?: (value: T) => Record<string, unknown>,
): Promise<T> {
  const started = Date.now()
  if (tracer === undefined) return run()
  try {
    const value = await run()
    tracer.log('debug', op, event, { ms: Date.now() - started, ...detail?.(value) })
    return value
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    tracer.log('warn', op, event, { ms: Date.now() - started, error: message.slice(0, STRING_LIMIT) })
    throw error
  }
}

/** Whether `DSH_MEMORY_LOG` asks for the file sink without a config edit. */
export function envDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|on|debug)$/i.test(env['DSH_MEMORY_LOG'] ?? '')
}

// --- shared gated tracer -----------------------------------------------------
//
// Since the component split, five separately toggleable plugins emit events,
// and the `memory_debug` tool plus the file sink belong to the debug component
// alone. One process-wide tracer behind a gate keeps that honest: enabling the
// debug component turns the gate on (and binds the file sink), disabling it
// turns every trace output off — no ring growth, no file writes, no readers.

let shared: Tracer = createTracer({ capacity: RING_DEFAULT })
let gate = false

/**
 * (Re)arm the shared tracer. Called by the debug component on mount; toggling
 * rebuilds the tracer, so the ring starts clean for this enable cycle.
 */
export function configureTracing(options: { file?: string; capacity?: number } = {}): void {
  shared = createTracer(options)
  gate = true
}

/** Silence every trace output; called when the debug component is disposed. */
export function shutdownTracing(): void {
  gate = false
}

/** Whether the debug component currently holds the gate open. */
export function tracingEnabled(): boolean {
  return gate
}

/** The Tracer every component shares: a no-op sink while the gate is shut. */
export const sharedTracer: Tracer = {
  log(level, op, event, detail) {
    if (gate) shared.log(level, op, event, detail)
  },
  recent(query = {}) {
    return gate ? shared.recent(query) : []
  },
  file() {
    return gate ? shared.file() : undefined
  },
}
