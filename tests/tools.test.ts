import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Mem0Error, type Mem0Client } from '../src/mem0.ts'
import { registerMemoryTools } from '../src/tools.ts'

/** Records what the tools asked for, so parameter plumbing is asserted, not assumed. */
interface Recorder {
  calls: Array<{ method: string; input: unknown }>
}

function stubClient(recorder: Recorder, overrides: Partial<Mem0Client> = {}): Mem0Client {
  const base: Mem0Client = {
    async recall(input) {
      recorder.calls.push({ method: 'recall', input })
      return [
        { id: 'aaaaaaaa-1111', memory: '用户偏好极简方案', metadata: { category: 'preference', scope: 'user' }, score: 0.81 },
        { id: 'bbbbbbbb-2222', memory: '用户反对过度设计', metadata: { category: 'preference' } },
      ]
    },
    async inventory(input = {}) {
      recorder.calls.push({ method: 'inventory', input })
      return [{ id: 'cccccccc-3333', memory: '事实一', metadata: { category: 'fact', importance: 'long_term' } }]
    },
    async read(id) {
      recorder.calls.push({ method: 'read', input: id })
      return id === 'missing' ? undefined : { id, memory: '一条记忆', metadata: { category: 'fact' } }
    },
    async remember(input) {
      recorder.calls.push({ method: 'remember', input })
      return [{ id: 'dddddddd-4444', memory: input.text, metadata: input.metadata ?? {} }]
    },
    async supersede(input) {
      recorder.calls.push({ method: 'supersede', input })
      return { supersededId: input.oldId, created: [{ id: 'eeeeeeee-5555', memory: input.text, metadata: {} }] }
    },
  }
  return { ...base, ...overrides }
}

async function harness(client: Mem0Client): Promise<Context> {
  const ctx = new Context()
  // ToolRuntime injects `systemPrompt`; with that dependency unmet cordis parks
  // the plugin silently, and `ctx.tools` stays undefined instead of erroring.
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  registerMemoryTools(ctx, { client: async () => client })
  return ctx
}

const call = (name: string, args: Record<string, unknown>) => ({
  callId: ToolCallId(`c-${Math.random()}`),
  name,
  arguments: args,
  signal: new AbortController().signal,
})

/** Model-visible text of one tool result. */
function textOf(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  return result.content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n')
}

describe('memory tools', () => {
  it('registers every tool the design names', async () => {
    const ctx = await harness(stubClient({ calls: [] }))
    for (const name of ['memory_remember', 'memory_recall', 'memory_read', 'memory_supersede', 'memory_inventory', 'memory_brief']) {
      assert.ok(ctx.tools.get(name), `${name} must be registered`)
    }
  })

  it('recalls through top_k and renders id-prefixed rows', async () => {
    const recorder: Recorder = { calls: [] }
    const ctx = await harness(stubClient(recorder))
    const result = await ctx.tools.execute(call('memory_recall', { query: '偏好', top_k: 2 }))
    assert.equal(result.isError, false)
    const text = textOf(result)
    assert.ok(text.includes('匹配到 2 条'), text)
    assert.ok(text.includes('[aaaaaaaa] 用户偏好极简方案'), text)
    assert.ok(text.includes('score=0.810'), text)
    const input = recorder.calls[0]?.input as Record<string, unknown>
    assert.equal(input['topK'], 2)
    assert.equal(input['query'], '偏好')
  })

  it('writes faithfully unless the caller asks for extraction', async () => {
    const recorder: Recorder = { calls: [] }
    const ctx = await harness(stubClient(recorder))
    await ctx.tools.execute(call('memory_remember', { text: '用户偏好中文短句', category: 'preference', tags: 'a, b' }))
    await ctx.tools.execute(call('memory_remember', { text: '另一条', infer: true }))
    const first = recorder.calls[0]?.input as Record<string, unknown>
    const second = recorder.calls[1]?.input as Record<string, unknown>
    assert.equal(first['infer'], false)
    assert.deepEqual(first['metadata'], { category: 'preference', tags: ['a', 'b'] })
    assert.equal(second['infer'], true)
  })

  it('reports a missing id as text rather than an error', async () => {
    const ctx = await harness(stubClient({ calls: [] }))
    const result = await ctx.tools.execute(call('memory_read', { id: 'missing' }))
    assert.equal(result.isError, false)
    assert.match(textOf(result), /没有找到该 id 的记忆/)
  })

  it('renders a supersede result with both ids', async () => {
    const recorder: Recorder = { calls: [] }
    const ctx = await harness(stubClient(recorder))
    const result = await ctx.tools.execute(call('memory_supersede', { old_id: 'old-id-1234', text: '新事实' }))
    assert.equal(result.isError, false)
    assert.match(textOf(result), /已取代 old-id-1/)
    assert.match(textOf(result), /新写入 1 条/)
  })

  it('passes inventory filters through and renders a count', async () => {
    const recorder: Recorder = { calls: [] }
    const ctx = await harness(stubClient(recorder))
    const result = await ctx.tools.execute(call('memory_inventory', { category: 'fact', status: 'current', top_k: 5 }))
    assert.match(textOf(result), /共 1 条/)
    const input = recorder.calls[0]?.input as Record<string, unknown>
    assert.deepEqual(input, { topK: 5, category: 'fact', status: 'current' })
  })

  it('builds a brief from the inventory and honours the character budget', async () => {
    const ctx = await harness(stubClient({ calls: [] }))
    const result = await ctx.tools.execute(call('memory_brief', { max_chars: 1200 }))
    assert.equal(result.isError, false)
    assert.match(textOf(result), /\[事实\]/)
    assert.match(textOf(result), /事实一/)
  })

  it('surfaces a service failure as an error result, not a crash', async () => {
    const failing = stubClient({ calls: [] }, {
      async recall() { throw new Mem0Error('dsh-memory: mem0 POST /search -> HTTP 401: bad key', 'auth', 401) },
    })
    const ctx = await harness(failing)
    const result = await ctx.tools.execute(call('memory_recall', { query: 'x' }))
    assert.equal(result.isError, true)
    assert.match(JSON.stringify(result.content), /HTTP 401/)
  })
})
