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
import * as memoryCore from '../src/index.ts'
import * as memoryRecall from '../src/recall-plugin.ts'
import * as memoryCapture from '../src/capture-plugin.ts'
import * as memoryReview from '../src/review-plugin.ts'
import * as memoryDebug from '../src/debug-plugin.ts'
import { activeBootReporter, clearBootReporter } from '../src/boot.ts'
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

/** Mount the bundle the way the patch does: debug first, then the siblings. */
async function mountBundle(ctx: Context, options: { debugLog?: boolean } = {}): Promise<string> {
  const dir = freshDir()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(memoryDebug, { pendingDir: dir, ...options.debugLog === undefined ? {} : { debugLog: options.debugLog } })
  await ctx.plugin(memoryCore, {})
  await ctx.plugin(memoryRecall, {})
  await ctx.plugin(memoryCapture, { pendingDir: dir })
  await ctx.plugin(memoryReview, { pendingDir: dir })
  return dir
}

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
    // No credentials service here: the point is that mounting still succeeds and
    // the failure appears where a human can act on it, not at load time.
    await mountBundle(ctx)

    for (const tool of ['memory_remember', 'memory_recall', 'memory_read', 'memory_supersede', 'memory_inventory', 'memory_brief', 'memory_review', 'memory_debug']) {
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

  it('boot report names every module; a failed module records its reason', async () => {
    const ctx = new Context()
    // No credentials service on purpose: the boot report must show the
    // credentials module as failed with the reason, and skip the mem0 ping.
    await mountBundle(ctx, { debugLog: true })

    // The boot chain runs detached; poll the debug ring until the summary lands.
    const readDebug = async (): Promise<string> => {
      const result = await ctx.tools.execute({
        callId: ToolCallId('boot-check'),
        name: 'memory_debug',
        arguments: { limit: 100 },
        signal: new AbortController().signal,
      })
      const blocks = result.content as Array<{ type: string; text?: string }>
      return blocks.map((block) => block.text ?? '').join('\n')
    }
    let text = ''
    for (let i = 0; i < 50; i++) {
      text = await readDebug()
      if (text.includes('自检完成')) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    assert.match(text, /boot\/summary/, 'the boot summary must land in the trace ring')
    for (const module of ['tools', 'skill', 'recall', 'capture', 'review', 'route', 'tracer', 'queue', 'credentials', 'mem0']) {
      assert.match(text, new RegExp(`boot/${module} `), `module ${module} must be reported`)
    }
    assert.match(text, /boot\/credentials \{"state":"fail"/, 'the credential failure must be visible')
    assert.match(text, /MEM0_API_KEY 凭据/, 'with the actionable reason')
    assert.match(text, /boot\/mem0 \{"state":"skip"/, 'and the ping must be skipped, not silently dropped')
  })

  it('without the debug component there is no trace gate, no debug tool, and no boot slot', async () => {
    // Earlier tests in this file mounted debug and never disposed the context
    // (test hosts don't); clearing the slot here is exactly what the debug
    // component's dispose effect does when the toggle turns it off.
    clearBootReporter()
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(memoryCore, {})
    await ctx.plugin(memoryReview, { pendingDir: freshDir() })

    assert.equal(ctx.tools.get('memory_debug'), undefined, 'memory_debug belongs to the debug component alone')
    // Sibling mount lines go nowhere; a healthy boot stays fully silent.
    assert.equal(activeBootReporter(), undefined, 'no boot reporter without the debug component')
  })
})
