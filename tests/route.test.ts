import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import type { Mem0Client, MemoryRow } from '../src/mem0.ts'
import { createQueue, type PendingQueue } from '../src/queue.ts'
import { handlePendingRequest, PENDING_PREFIX, registerPendingRoute } from '../src/route.ts'

const roots: string[] = []
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-route-'))
  roots.push(dir)
  return dir
}
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

interface Recorder { calls: Array<{ method: string; input: unknown }> }

function stubClient(recorder: Recorder, hits: MemoryRow[] = []): Mem0Client {
  return {
    async recall(input) { recorder.calls.push({ method: 'recall', input }); return hits },
    async inventory() { return [] },
    async read() { return undefined },
    async remember(input) {
      recorder.calls.push({ method: 'remember', input })
      return [{ id: 'stored-1234', memory: input.text, metadata: {} }]
    },
    async supersede(input) {
      recorder.calls.push({ method: 'supersede', input })
      return { supersededId: input.oldId, created: [{ id: 'new-5678', memory: input.text, metadata: {} }] }
    },
  }
}

function queueWith(dir: string): PendingQueue {
  return createQueue({ dir, now: () => new Date('2026-10-08T10:00:00Z') })
}

describe('pending route behaviour', () => {
  it('lists pending entries with their ids and text', async () => {
    const queue = queueWith(freshDir())
    const entry = await queue.offer({ text: '用户偏好极简输出', confidence: 0.8 })
    assert.ok(entry)

    const response = await handlePendingRequest({ queue, client: async () => stubClient({ calls: [] }) }, {
      method: 'GET',
      path: PENDING_PREFIX,
    })
    assert.equal(response.status, 200)
    assert.equal(response.body['ok'], true)
    assert.match(String(response.body['text']), /待审 1 条/)
    const entries = response.body['entries'] as Array<{ id: string }>
    assert.equal(entries.length, 1)
    assert.equal(entries[0]?.id, entry.id)
  })

  it('approves through the same dedupe-then-write flow the tool uses', async () => {
    const recorder: Recorder = { calls: [] }
    const queue = queueWith(freshDir())
    const hits: MemoryRow[] = [{ id: 'existing-1', memory: '同一事实', metadata: {}, score: 0.95 }]
    const entry = await queue.offer({ text: '同一事实', confidence: 0.8 })
    assert.ok(entry)

    const response = await handlePendingRequest({ queue, client: async () => stubClient(recorder, hits) }, {
      method: 'POST',
      path: `${PENDING_PREFIX}/approve`,
      body: { id: entry.id.slice(0, 6), note: 'sidebar' },
    })
    assert.equal(response.status, 200)
    assert.equal(response.body['ok'], true)
    assert.match(String(response.body['text']), /已批准并取代/)

    const stored = (await queue.list())[0]
    assert.equal(stored?.status, 'approved')
    assert.equal(stored?.decided_by, 'sidebar')
    assert.equal(stored?.supersedes, 'existing-1')
  })

  it('dismisses without calling mem0', async () => {
    const recorder: Recorder = { calls: [] }
    const queue = queueWith(freshDir())
    const entry = await queue.offer({ text: '不该记住', confidence: 0.7 })
    assert.ok(entry)

    const response = await handlePendingRequest({ queue, client: async () => stubClient(recorder) }, {
      method: 'POST',
      path: `${PENDING_PREFIX}/dismiss`,
      body: { id: entry.id },
    })
    assert.equal(response.status, 200)
    assert.equal(recorder.calls.length, 0)
    assert.equal((await queue.list())[0]?.status, 'dismissed')
  })

  it('answers bad requests with a status the caller can act on', async () => {
    const queue = queueWith(freshDir())
    const deps = { queue, client: async () => stubClient({ calls: [] }) }

    const missingId = await handlePendingRequest(deps, { method: 'POST', path: `${PENDING_PREFIX}/approve`, body: {} })
    assert.equal(missingId.status, 400)

    const unknownPath = await handlePendingRequest(deps, { method: 'POST', path: `${PENDING_PREFIX}/frobnicate`, body: { id: 'x' } })
    assert.equal(unknownPath.status, 404)

    const unknownId = await handlePendingRequest(deps, { method: 'POST', path: `${PENDING_PREFIX}/dismiss`, body: { id: 'ghost' } })
    assert.equal(unknownId.status, 404)
    assert.match(String(unknownId.body['text']), /没有找到候审条目/)

    const wrongMethod = await handlePendingRequest(deps, { method: 'PUT', path: PENDING_PREFIX })
    assert.equal(wrongMethod.status, 405)
  })
})

describe('pending route registration', () => {
  it('registers a prefix route and disposes it through the context effect', () => {
    const registered: Array<{ kind: string; path: string }> = []
    let disposed = false
    const effects: Array<() => void> = []
    const host = {
      get: (key: string) => key === 'webServer'
        ? {
            register: (route: { kind: string; path: string }) => {
              registered.push(route)
              return () => { disposed = true }
            },
          }
        : undefined,
      effect: (register: () => () => void) => { effects.push(register()) },
    }

    registerPendingRoute(host, { queue: queueWith(freshDir()), client: async () => stubClient({ calls: [] }) })
    assert.equal(registered.length, 1)
    assert.equal(registered[0]?.kind, 'prefix')
    assert.equal(registered[0]?.path, PENDING_PREFIX)
    for (const dispose of effects) dispose()
    assert.equal(disposed, true, 'the route must not outlive its context')
  })

  it('is a no-op on a host without a webServer', () => {
    assert.doesNotThrow(() => { registerPendingRoute({}, { queue: queueWith(freshDir()), client: async () => stubClient({ calls: [] }) }) })
    assert.doesNotThrow(() => { registerPendingRoute({ get: () => undefined }, { queue: queueWith(freshDir()), client: async () => stubClient({ calls: [] }) }) })
  })
})
