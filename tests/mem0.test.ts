import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { createMem0Client, filterRows, Mem0Error, toMemoryRow, toRows } from '../src/mem0.ts'

interface Call {
  method: string
  url: string
  headers: Record<string, string>
  body?: unknown
}

/** A fetch double that records every call and answers from the supplied table. */
function makeFetch(respond: (call: Call) => { status?: number; body: unknown }): {
  fetchImpl: typeof fetch
  calls: Call[]
} {
  const calls: Call[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) },
    }
    calls.push(call)
    const { status = 200, body } = respond(call)
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  return { fetchImpl, calls }
}

const row = (id: string, memory: string, metadata: Record<string, unknown> = {}) => ({ id, memory, metadata })

describe('mem0 client', () => {
  it('sends the API key header and never caches it across calls', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ body: { results: [] } }))
    const client = createMem0Client({ baseUrl: 'http://mem0.test', apiKey: 'k-1', userId: 'u', fetchImpl })
    await client.recall({ query: 'a' })
    await client.recall({ query: 'b' })
    assert.equal(calls.length, 2)
    for (const call of calls) assert.equal(call.headers['X-API-Key'], 'k-1')
  })

  // The measured defect this replaces: the Python bridge sent `limit`, which the
  // service ignores, so it always answered with its default 20 rows.
  it('sizes the search with top_k, and never sends limit', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ body: { results: [] } }))
    const client = createMem0Client({ baseUrl: 'http://mem0.test', apiKey: 'k', userId: 'u', fetchImpl })
    await client.recall({ query: '记忆', topK: 3 })
    const body = calls[0]?.body as Record<string, unknown>
    assert.equal(body['top_k'], 3)
    assert.equal('limit' in body, false)
    assert.equal(body['user_id'], 'u')
  })

  it('filters historical, category, and scope client-side after searching', async () => {
    const { fetchImpl } = makeFetch(() => ({
      body: {
        results: [
          row('1', 'a', { status: 'current', category: 'preference', scope: 'user' }),
          row('2', 'b', { status: 'historical', category: 'preference', scope: 'user' }),
          row('3', 'c', { status: 'current', category: 'workflow', scope: 'user' }),
          row('4', 'd', { status: 'current', category: 'preference', scope: 'project' }),
        ],
      },
    }))
    const client = createMem0Client({ baseUrl: 'http://mem0.test', apiKey: 'k', userId: 'u', fetchImpl })
    const all = await client.recall({ query: 'q' })
    assert.deepEqual(all.map((r) => r.id), ['1', '3', '4'])
    const filtered = await client.recall({ query: 'q', category: 'preference', scope: 'user' })
    assert.deepEqual(filtered.map((r) => r.id), ['1'])
  })

  it('writes faithfully by default and only extracts when asked', async () => {
    const { fetchImpl, calls } = makeFetch(() => ({ body: { results: [row('new', 'text')] } }))
    const client = createMem0Client({ baseUrl: 'http://mem0.test', apiKey: 'k', userId: 'u', fetchImpl })
    await client.remember({ text: '用户偏好极简方案', metadata: { category: 'preference' } })
    await client.remember({ text: '另一条', infer: true })
    const first = calls[0]?.body as Record<string, unknown>
    const second = calls[1]?.body as Record<string, unknown>
    assert.equal(first['infer'], false, 'a faithful write must not be left to the extractor')
    assert.deepEqual(first['messages'], [{ role: 'user', content: '用户偏好极简方案' }])
    assert.deepEqual(first['metadata'], { category: 'preference' })
    assert.equal(second['infer'], true)
  })

  it('expresses supersede as the data shape the service uses', async () => {
    const { fetchImpl, calls } = makeFetch((call) => {
      if (call.method === 'GET') {
        return { body: { id: 'old', memory: '旧事实', metadata: { category: 'decision', importance: 'long_term', tags: ['t'] } } }
      }
      if (call.method === 'PUT') return { body: {} }
      return { body: { results: [row('fresh', '新事实')] } }
    })
    const client = createMem0Client({ baseUrl: 'http://mem0.test', apiKey: 'k', userId: 'u', fetchImpl })
    const result = await client.supersede({ oldId: 'old', text: '新事实', source: 'session:x' })
    assert.equal(result.supersededId, 'old')
    assert.equal(result.created[0]?.id, 'fresh')

    const put = calls.find((call) => call.method === 'PUT')
    assert.ok(put !== undefined, 'a PUT must rewrite the old row')
    const putBody = put.body as Record<string, unknown>
    assert.equal((putBody['metadata'] as Record<string, unknown>)['status'], 'historical')
    assert.equal((putBody['metadata'] as Record<string, unknown>)['category'], 'decision')
    assert.equal(putBody['text'], '旧事实', 'the old row keeps its text so history stays readable')

    const post = calls.find((call) => call.method === 'POST')
    assert.ok(post !== undefined, 'a POST must create the replacement row')
    const postBody = post.body as Record<string, unknown>
    const postMeta = postBody['metadata'] as Record<string, unknown>
    assert.equal(postMeta['status'], 'current')
    assert.equal(postMeta['supersedes'], 'old')
    assert.equal(postBody['infer'], false)
  })

  it('classifies failures so callers can act on them', async () => {
    const auth = createMem0Client({
      baseUrl: 'http://mem0.test', apiKey: 'bad', userId: 'u',
      fetchImpl: makeFetch(() => ({ status: 401, body: { detail: 'unauthorized' } })).fetchImpl,
    })
    await assert.rejects(() => auth.recall({ query: 'q' }), (error: unknown) => {
      assert.ok(error instanceof Mem0Error)
      assert.equal(error.kind, 'auth')
      assert.equal(error.status, 401)
      return true
    })

    const down = createMem0Client({
      baseUrl: 'http://mem0.test', apiKey: 'k', userId: 'u',
      fetchImpl: (() => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch,
    })
    await assert.rejects(() => down.recall({ query: 'q' }), (error: unknown) => {
      assert.ok(error instanceof Mem0Error)
      assert.equal(error.kind, 'network')
      return true
    })
  })
})

describe('mem0 row mapping', () => {
  it('unwraps both envelopes and drops rows without id or text', () => {
    assert.equal(toRows({ results: [row('1', 'a'), { memory: 'no id' }] }).length, 1)
    assert.equal(toRows([row('2', 'b')]).length, 1)
    assert.equal(toRows(null).length, 0)
    assert.equal(toRows({ results: 'nope' }).length, 0)
  })

  it('keeps only the fields the plugin relies on and tolerates missing metadata', () => {
    const mapped = toMemoryRow({ id: '1', memory: 'a', hash: 'h', created_at: 'c', score: 0.5 })
    assert.deepEqual(mapped, { id: '1', memory: 'a', hash: 'h', createdAt: 'c', score: 0.5, metadata: {} })
    assert.equal(toMemoryRow({ memory: 'no id' }), undefined)
  })

  it('filters by status, category, and scope without mutating the input', () => {
    const rows = [
      { id: '1', memory: 'a', metadata: { status: 'current', category: 'x', scope: 'user' } },
      { id: '2', memory: 'b', metadata: { status: 'historical', category: 'x', scope: 'user' } },
    ]
    assert.deepEqual(filterRows(rows, {}).map((r) => r.id), ['1'])
    assert.deepEqual(filterRows(rows, { includeHistorical: true }).map((r) => r.id), ['1', '2'])
    assert.equal(rows.length, 2)
  })
})
