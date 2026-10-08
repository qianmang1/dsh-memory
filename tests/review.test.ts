import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Mem0Client, MemoryRow } from '../src/mem0.ts'
import { createQueue } from '../src/queue.ts'
import { registerReviewTool } from '../src/review.ts'

const roots: string[] = []
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-review-'))
  roots.push(dir)
  return dir
}
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

interface Recorder {
  calls: Array<{ method: string; input: unknown }>
}

function stubClient(recorder: Recorder, hits: MemoryRow[] = []): Mem0Client {
  return {
    async recall(input) {
      recorder.calls.push({ method: 'recall', input })
      return hits
    },
    async inventory() { return [] },
    async read() { return undefined },
    async remember(input) {
      recorder.calls.push({ method: 'remember', input })
      return [{ id: 'stored-id-7777', memory: input.text, metadata: input.metadata ?? {} }]
    },
    async supersede(input) {
      recorder.calls.push({ method: 'supersede', input })
      return { supersededId: input.oldId, created: [{ id: 'replacement-8888', memory: input.text, metadata: {} }] }
    },
  }
}

async function harness(client: Mem0Client, dir: string) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  const queue = createQueue({ dir, now: () => new Date('2026-10-08T10:00:00Z') })
  registerReviewTool(ctx, { queue, client: async () => client })
  return { ctx, queue }
}

const call = (args: Record<string, unknown>) => ({
  callId: ToolCallId(`c-${Math.random()}`),
  name: 'memory_review',
  arguments: args,
  signal: new AbortController().signal,
})

function textOf(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
  return result.content.filter((block) => block.type === 'text').map((block) => block.text ?? '').join('\n')
}

describe('memory_review', () => {
  it('says the queue is empty rather than rendering a bare header', async () => {
    const recorder: Recorder = { calls: [] }
    const { ctx } = await harness(stubClient(recorder), freshDir())
    const result = await ctx.tools.execute(call({ action: 'list' }))
    assert.match(textOf(result), /候审队列为空/)
  })

  it('lists pending entries with a short id a reviewer can quote back', async () => {
    const recorder: Recorder = { calls: [] }
    const { ctx, queue } = await harness(stubClient(recorder), freshDir())
    const entry = await queue.offer({ text: '用户偏好极简输出', confidence: 0.8, metadata: { category: 'preference' } })
    assert.ok(entry)
    const result = await ctx.tools.execute(call({ action: 'list' }))
    const text = textOf(result)
    assert.match(text, /待审 1 条/)
    assert.ok(text.includes(entry.id.slice(0, 6)), text)
    assert.match(text, /用户偏好极简输出/)
  })

  it('approves a fact that is not in mem0 yet by writing it faithfully', async () => {
    const recorder: Recorder = { calls: [] }
    const { ctx, queue } = await harness(stubClient(recorder), freshDir())
    const entry = await queue.offer({ text: '用户偏好极简输出', confidence: 0.8 })
    assert.ok(entry)

    const result = await ctx.tools.execute(call({ action: 'approve', id: entry.id.slice(0, 6) }))
    assert.match(textOf(result), /已批准并写入 stored-i/)

    const remember = recorder.calls.find((entryCall) => entryCall.method === 'remember')
    const input = remember?.input as Record<string, unknown>
    assert.equal(input['infer'], false, 'approval must not hand the wording to the extractor')

    const stored = (await queue.list())[0]
    assert.equal(stored?.status, 'approved')
    assert.equal(stored?.stored_memory_id, 'stored-id-7777')
  })

  it('supersedes instead of duplicating when a strong hit exists', async () => {
    const recorder: Recorder = { calls: [] }
    const hits: MemoryRow[] = [{ id: 'existing-9999', memory: '用户偏好完整输出', metadata: {}, score: 0.93 }]
    const { ctx, queue } = await harness(stubClient(recorder, hits), freshDir())
    const entry = await queue.offer({ text: '用户偏好极简输出', confidence: 0.8 })
    assert.ok(entry)

    const result = await ctx.tools.execute(call({ action: 'approve', id: entry.id }))
    assert.match(textOf(result), /已批准并取代 existing/)

    assert.equal(recorder.calls.some((entryCall) => entryCall.method === 'supersede'), true)
    assert.equal(recorder.calls.some((entryCall) => entryCall.method === 'remember'), false)

    const stored = (await queue.list())[0]
    assert.equal(stored?.status, 'approved')
    assert.equal(stored?.supersedes, 'existing-9999')
    assert.equal(stored?.stored_memory_id, 'replacement-8888')
  })

  it('writes a new fact when the best hit is below the dedupe threshold', async () => {
    const recorder: Recorder = { calls: [] }
    const hits: MemoryRow[] = [{ id: 'weak-1111', memory: '有点相关', metadata: {}, score: 0.42 }]
    const { ctx, queue } = await harness(stubClient(recorder, hits), freshDir())
    const entry = await queue.offer({ text: '另一条独立事实', confidence: 0.8 })
    assert.ok(entry)

    await ctx.tools.execute(call({ action: 'approve', id: entry.id }))
    assert.equal(recorder.calls.some((entryCall) => entryCall.method === 'remember'), true)
    assert.equal(recorder.calls.some((entryCall) => entryCall.method === 'supersede'), false)
  })

  it('dismisses without touching mem0, and stops listing the entry', async () => {
    const recorder: Recorder = { calls: [] }
    const { ctx, queue } = await harness(stubClient(recorder), freshDir())
    const entry = await queue.offer({ text: '不该记住的内容', confidence: 0.8 })
    assert.ok(entry)

    const result = await ctx.tools.execute(call({ action: 'dismiss', id: entry.id, note: '不成立' }))
    assert.match(textOf(result), /已驳回/)
    assert.equal(recorder.calls.length, 0, 'dismissal must not call mem0 at all')
    assert.equal((await queue.list())[0]?.status, 'dismissed')
    assert.match(textOf(await ctx.tools.execute(call({ action: 'list' }))), /候审队列为空/)
  })

  it('explains what is missing instead of failing silently', async () => {
    const recorder: Recorder = { calls: [] }
    const { ctx } = await harness(stubClient(recorder), freshDir())
    assert.match(textOf(await ctx.tools.execute(call({ action: 'approve' }))), /需要 id/)
    assert.match(textOf(await ctx.tools.execute(call({ action: 'approve', id: 'nope' }))), /没有找到候审条目/)
    assert.match(textOf(await ctx.tools.execute(call({ action: 'frobnicate' }))), /未知 action/)
  })
})
