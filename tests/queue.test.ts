import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { createQueue, hashText, normalizeText, parseEntries, renderMarkdown } from '../src/queue.ts'

const roots: string[] = []
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-queue-'))
  roots.push(dir)
  return dir
}

/** A queue whose clock is fixed, so TTL behaviour is asserted and not waited on. */
function queueAt(dir: string, iso: string, ttlDays = 7) {
  return createQueue({ dir, ttlDays, now: () => new Date(iso) })
}

after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }) })

describe('queue', () => {
  it('appends a candidate, writes the derived view, and reads it back', async () => {
    const dir = freshDir()
    const queue = queueAt(dir, '2026-10-08T10:00:00Z')
    const entry = await queue.offer({
      text: '用户要求输出区分事实与推测',
      metadata: { category: 'preference', scope: 'user' },
      evidence: 'session:abc',
      confidence: 0.8,
    })
    assert.ok(entry)
    assert.equal(entry.status, 'pending')
    assert.equal(entry.confidence, 0.8)

    const listed = await queue.list()
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.text, '用户要求输出区分事实与推测')

    const view = readFileSync(queue.paths().markdown, 'utf8')
    assert.match(view, /## 待审 1/)
    assert.match(view, /\[[0-9a-f]{6}\] 用户要求输出区分事实与推测/)
    assert.match(view, /conf 0\.80/)
  })

  it('dedupes across punctuation and whitespace, including decided entries', async () => {
    const dir = freshDir()
    const queue = queueAt(dir, '2026-10-08T10:00:00Z')
    await queue.offer({ text: '用户偏好极简方案', confidence: 0.9 })
    const duplicate = await queue.offer({ text: '用户偏好极简方案。', confidence: 0.9 })
    assert.equal(duplicate, undefined, 'a reworded duplicate must not re-enter')

    const first = (await queue.list())[0]
    assert.ok(first)
    await queue.decide(first.id, 'dismissed')
    const afterDismissal = await queue.offer({ text: '用户偏好极简方案', confidence: 0.95 })
    assert.equal(afterDismissal, undefined, 'a dismissed fact must not come back every turn')
    assert.equal((await queue.list()).length, 1)
  })

  it('records a decision with its audit fields and refreshes the view', async () => {
    const dir = freshDir()
    const queue = queueAt(dir, '2026-10-08T10:00:00Z')
    const entry = await queue.offer({ text: '用户用 pgvector 存向量', confidence: 0.7 })
    assert.ok(entry)

    const decided = await queue.decide(entry.id, 'approved', {
      storedMemoryId: 'mem0-id-9999',
      supersedes: 'old-id-0000',
      decidedBy: 'human',
    })
    assert.equal(decided?.status, 'approved')
    assert.equal(decided?.stored_memory_id, 'mem0-id-9999')
    assert.equal(decided?.supersedes, 'old-id-0000')
    assert.ok(decided?.decided_at)

    const view = readFileSync(queue.paths().markdown, 'utf8')
    assert.match(view, /## 已批准 1/)
    assert.match(view, /mem0：mem0-id/)
    assert.match(view, /取代：old-id-0/)
  })

  it('returns undefined for an unknown id instead of corrupting the file', async () => {
    const dir = freshDir()
    const queue = queueAt(dir, '2026-10-08T10:00:00Z')
    await queue.offer({ text: '一条', confidence: 0.7 })
    assert.equal(await queue.decide('nope', 'approved'), undefined)
    assert.equal((await queue.list()).length, 1)
  })

  it('expires only overdue pending entries and archives them', async () => {
    const dir = freshDir()
    const old = queueAt(dir, '2026-10-01T00:00:00Z')
    await old.offer({ text: '过期候选', confidence: 0.7 })

    // Same directory, later clock: the entry is now 8 days old against a 7-day TTL.
    const later = queueAt(dir, '2026-10-09T00:00:00Z')
    const fresh = await later.offer({ text: '今天刚入队', confidence: 0.7 })
    assert.ok(fresh)

    const moved = await later.expire()
    assert.equal(moved, 1)
    const entries = await later.list()
    assert.equal(entries.find((entry) => entry.text === '过期候选')?.status, 'expired')
    assert.equal(entries.find((entry) => entry.text === '今天刚入队')?.status, 'pending', 'a fresh entry must survive')

    const archive = readFileSync(later.paths().archive, 'utf8')
    assert.match(archive, /过期候选/)
    assert.equal(await later.expire(), 0, 'expiring twice must be a no-op')
  })

  it('survives a torn trailing line from an interrupted append', async () => {
    const dir = freshDir()
    const queue = queueAt(dir, '2026-10-08T10:00:00Z')
    await queue.offer({ text: '完整条目', confidence: 0.7 })
    const source = readFileSync(queue.paths().jsonl, 'utf8')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(queue.paths().jsonl, `${source}{"id":"torn","text":"半`, 'utf8')
    const entries = await queue.list()
    assert.equal(entries.length, 1, 'the intact line must still be readable')
    assert.equal(entries[0]?.text, '完整条目')
  })

  it('rejects an empty candidate', async () => {
    const dir = freshDir()
    const queue = queueAt(dir, '2026-10-08T10:00:00Z')
    assert.equal(await queue.offer({ text: '   ', confidence: 0.9 }), undefined)
    assert.equal((await queue.list()).length, 0)
  })
})

describe('queue rendering helpers', () => {
  it('normalizes punctuation and whitespace into one dedupe key', () => {
    assert.equal(normalizeText('用户偏好极简方案。'), normalizeText('用户 偏好极简方案'))
    assert.equal(hashText('a-b c'), hashText('ab c'))
    assert.notEqual(hashText('用户偏好极简方案'), hashText('用户偏好完整方案'))
  })

  it('parses valid lines and drops malformed ones', () => {
    const valid = JSON.stringify({ id: 'a', text: 't', hash: 'h', confidence: 1, created_at: 'now', status: 'pending', metadata: {} })
    assert.equal(parseEntries(`${valid}\nnot json\n\n`).length, 1)
    assert.equal(parseEntries('').length, 0)
  })

  it('renders sections in review order and says so when empty', () => {
    const empty = renderMarkdown([])
    assert.match(empty, /队列为空/)
    const rendered = renderMarkdown([
      { id: 'aaaaaa-1', hash: 'h', text: '待审的', metadata: {}, confidence: 0.7, created_at: 't', status: 'pending' },
      { id: 'bbbbbb-2', hash: 'h2', text: '已驳回的', metadata: {}, confidence: 0.7, created_at: 't', status: 'dismissed' },
    ])
    assert.ok(rendered.indexOf('## 待审') < rendered.indexOf('## 已驳回'))
  })
})
