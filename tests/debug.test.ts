import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { createMem0Client } from '../src/mem0.ts'
import { createTracer, envDebugEnabled, withTrace } from '../src/debug.ts'

const roots: string[] = []
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-debug-'))
  roots.push(dir)
  return dir
}

after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

describe('tracer', () => {
  it('keeps the ring bounded, dropping the oldest events first', () => {
    const tracer = createTracer({ capacity: 3 })
    for (let i = 0; i < 5; i++) tracer.log('debug', 'hook', `event-${i}`)
    const events = tracer.recent({ limit: 10 })
    assert.equal(events.length, 3)
    assert.equal(events[0]?.event, 'event-2')
    assert.equal(events[2]?.event, 'event-4')
  })

  it('redacts sensitive keys and truncates over-long strings', () => {
    const tracer = createTracer()
    tracer.log('debug', 'mem0', 'http', {
      apiKey: 'sk-should-vanish',
      Authorization: 'Bearer nope',
      nested: { token: 'also-nope', ok: 1 },
      long: 'x'.repeat(500),
    })
    const detail = tracer.recent({ limit: 1 })[0]?.detail as Record<string, unknown>
    assert.equal(detail['apiKey'], '[REDACTED]')
    assert.equal(detail['Authorization'], '[REDACTED]')
    assert.deepEqual(detail['nested'], { token: '[REDACTED]', ok: 1 })
    assert.match(detail['long'] as string, /^x{240}…\(\+260\)$/u)
  })

  it('filters recent events by level and op, and honours the limit', () => {
    const tracer = createTracer()
    tracer.log('debug', 'hook', 'a')
    tracer.log('info', 'hook', 'b')
    tracer.log('warn', 'mem0', 'c')
    tracer.log('info', 'hook', 'd')
    assert.equal(tracer.recent({ level: 'info', op: 'hook' }).length, 2)
    assert.equal(tracer.recent({ op: 'mem0' })[0]?.event, 'c')
    const limited = tracer.recent({ limit: 2 })
    assert.deepEqual(limited.map((entry) => entry.event), ['c', 'd'])
  })

  it('writes sanitized NDJSON to the file sink', async () => {
    const dir = freshDir()
    const file = join(dir, 'logs', 'trace.ndjson')
    const tracer = createTracer({ file })
    tracer.log('info', 'hook', 'recall.done', { rows: 2, apiKey: 'nope' })
    // The sink is asynchronous; the ring answers synchronously but the file
    // needs one macrotask of margin. Drain by awaiting a follow-up event's
    // chain indirectly — poll the file instead of sleep-based guesses.
    for (let i = 0; i < 50; i++) {
      try {
        const body = readFileSync(file, 'utf8')
        const lines = body.trim().split('\n')
        assert.equal(lines.length, 1)
        const parsed = JSON.parse(lines[0] ?? '{}') as { level: string; op: string; event: string; detail: Record<string, unknown> }
        assert.equal(parsed.level, 'info')
        assert.equal(parsed.event, 'recall.done')
        assert.equal(parsed.detail['apiKey'], '[REDACTED]')
        break
      } catch {
        if (i === 49) assert.fail('file sink never wrote')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    assert.equal(tracer.file(), file)
  })
})

describe('withTrace', () => {
  it('records success with derived detail and returns the value', async () => {
    const tracer = createTracer()
    const value = await withTrace(tracer, 'tool', 'op', async () => 42, (v) => ({ got: v }))
    assert.equal(value, 42)
    const event = tracer.recent({ limit: 1 })[0]
    assert.equal(event?.event, 'op')
    assert.deepEqual(event?.detail, { ms: event?.detail && typeof event.detail['ms'] === 'number' ? event.detail['ms'] : 0, got: 42 })
  })

  it('records a warn and rethrows unchanged on failure', async () => {
    const tracer = createTracer()
    const boom = new Error('boom')
    await assert.rejects(
      () => withTrace(tracer, 'tool', 'op', async () => { throw boom }),
      (error: unknown) => error === boom,
    )
    const event = tracer.recent({ limit: 1 })[0]
    assert.equal(event?.level, 'warn')
    assert.equal((event?.detail as Record<string, unknown>)['error'], 'boom')
  })

  it('runs the operation untouched when no tracer is given', async () => {
    const value = await withTrace(undefined, 'tool', 'op', async () => 'ok')
    assert.equal(value, 'ok')
  })
})

describe('envDebugEnabled', () => {
  it('accepts the affirmative spellings only', () => {
    assert.equal(envDebugEnabled({ DSH_MEMORY_LOG: '1' }), true)
    assert.equal(envDebugEnabled({ DSH_MEMORY_LOG: 'debug' }), true)
    assert.equal(envDebugEnabled({ DSH_MEMORY_LOG: 'off' }), false)
    assert.equal(envDebugEnabled({}), false)
  })
})

describe('mem0 trace seam', () => {
  const base = { baseUrl: 'http://mem0.test', apiKey: 'k', userId: 'u' }

  it('emits one http event per successful exchange, sizes only, no bodies', async () => {
    const events: Array<{ event: string; detail?: Record<string, unknown> }> = []
    const client = createMem0Client({
      ...base,
      onEvent: (event, detail) => events.push({ event, detail }),
      fetchImpl: (async () => new Response(JSON.stringify({ results: [] }), { status: 200 })) as typeof fetch,
    })
    await client.inventory({ topK: 5 })
    assert.equal(events.length, 1)
    assert.equal(events[0]?.event, 'http')
    const detail = events[0]?.detail as Record<string, unknown>
    assert.equal(detail['method'], 'GET')
    assert.match(detail['path'] as string, /^\/memories\?/)
    assert.equal(detail['status'], 200)
    assert.equal(typeof detail['ms'], 'number')
    assert.equal(detail['body'], undefined, 'bodies must never ride the trace')
  })

  it('emits an http_error event before rethrowing the classified failure', async () => {
    const events: Array<{ event: string; detail?: Record<string, unknown> }> = []
    const client = createMem0Client({
      ...base,
      onEvent: (event, detail) => events.push({ event, detail }),
      fetchImpl: (async () => new Response('denied', { status: 401 })) as typeof fetch,
    })
    await assert.rejects(() => client.recall({ query: 'x' }))
    assert.equal(events.length, 1)
    assert.equal(events[0]?.event, 'http_error')
    assert.equal((events[0]?.detail as Record<string, unknown>)['kind'], 'auth')
    assert.equal((events[0]?.detail as Record<string, unknown>)['status'], 401)
  })
})
