import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as memoryPlugin from '../src/index.ts'
import { createMem0Client } from '../src/mem0.ts'

interface Recorded {
  method: string
  url: string
  apiKey?: string
  body?: unknown
}

/** A local mem0 stand-in: enough of the contract to exercise the real HTTP path. */
async function startStub(): Promise<{ url: string; recorded: Recorded[]; close: () => Promise<void> }> {
  const recorded: Recorded[] = []
  const server = createServer((request, response) => {
    let raw = ''
    request.on('data', (chunk) => { raw += String(chunk) })
    request.on('end', () => {
      const record: Recorded = {
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        ...request.headers['x-api-key'] === undefined ? {} : { apiKey: String(request.headers['x-api-key']) },
        ...raw.length === 0 ? {} : { body: JSON.parse(raw) as unknown },
      }
      recorded.push(record)
      response.setHeader('Content-Type', 'application/json')
      const url = record.url
      if (request.method === 'POST' && url === '/search') {
        response.end(JSON.stringify({ results: [{ id: 'hit-1', memory: '命中的记忆', metadata: { status: 'current' }, score: 0.9 }] }))
        return
      }
      if (request.method === 'POST' && url === '/memories') {
        response.end(JSON.stringify({ results: [{ id: 'written-1', memory: '已写入', metadata: {} }] }))
        return
      }
      if (request.method === 'PUT') {
        response.end(JSON.stringify({}))
        return
      }
      if (request.method === 'GET' && url.startsWith('/memories/')) {
        response.end(JSON.stringify({ id: 'existing-1', memory: '旧记忆', metadata: { category: 'fact' } }))
        return
      }
      if (request.method === 'GET' && url.startsWith('/memories?')) {
        response.end(JSON.stringify({ results: [{ id: 'listed-1', memory: '列出的记忆', metadata: { status: 'current' } }] }))
        return
      }
      response.statusCode = 404
      response.end('{}')
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    recorded,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()) }),
  }
}

const roots: string[] = []
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-integration-'))
  roots.push(dir)
  return dir
}
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

describe('mem0 client over real HTTP', () => {
  it('sends the measured contract to a live server', async () => {
    const stub = await startStub()
    try {
      const client = createMem0Client({ baseUrl: stub.url, apiKey: 'test-key', userId: 'tester' })
      const rows = await client.recall({ query: '偏好', topK: 3 })
      assert.equal(rows.length, 1)
      assert.equal(rows[0]?.memory, '命中的记忆')

      const search = stub.recorded.find((record) => record.url === '/search')
      assert.equal(search?.apiKey, 'test-key', 'the service authenticates with X-API-Key')
      assert.deepEqual(search?.body, { query: '偏好', user_id: 'tester', top_k: 3 })

      await client.remember({ text: '一条新事实', metadata: { category: 'fact' } })
      const write = stub.recorded.find((record) => record.method === 'POST' && record.url === '/memories')
      const writeBody = write?.body as Record<string, unknown>
      assert.equal(writeBody['infer'], false)
      assert.deepEqual(writeBody['messages'], [{ role: 'user', content: '一条新事实' }])

      const superseded = await client.supersede({ oldId: 'existing-1', text: '新事实' })
      assert.equal(superseded.supersededId, 'existing-1')
      const puts = stub.recorded.filter((record) => record.method === 'PUT')
      assert.equal(puts.length, 1, 'the old row is rewritten before the new one is created')
      assert.equal(stub.recorded.filter((record) => record.method === 'POST' && record.url === '/memories').length, 2)
    } finally {
      await stub.close()
    }
  })
})

describe('plugin mounting', () => {
  it('registers every tool and survives a missing memory service', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    // No credentials service here: the point is that mounting still succeeds and
    // the failure appears where a human can act on it, not at load time.
    await ctx.plugin(memoryPlugin, { pendingDir: freshDir(), recall: false, capture: false })

    for (const tool of ['memory_remember', 'memory_recall', 'memory_read', 'memory_supersede', 'memory_inventory', 'memory_brief', 'memory_review']) {
      assert.ok(ctx.tools.get(tool), `${tool} must be registered`)
    }

    const result = await ctx.tools.execute({
      callId: ToolCallId('c-1'),
      name: 'memory_recall',
      arguments: { query: '偏好' },
      signal: new AbortController().signal,
    })
    assert.equal(result.isError, true)
    const text = JSON.stringify(result.content)
    assert.match(text, /MEM0_API_KEY/, 'the error must name the missing credential')
    assert.match(text, /credentials/, 'and say where to configure it')
  })
})
