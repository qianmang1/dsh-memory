import { strict as assert } from 'node:assert'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { configureTracing, sharedTracer, shutdownTracing, tracingEnabled } from '../src/debug.ts'
import { createQueue } from '../src/queue.ts'

const roots: string[] = []
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-components-'))
  roots.push(dir)
  return dir
}
after(() => {
  shutdownTracing()
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

describe('shared trace gate', () => {
  it('drops every event while shut and records once opened', () => {
    shutdownTracing()
    sharedTracer.log('info', 'test', 'silent', { n: 1 })
    assert.equal(sharedTracer.recent().length, 0, 'a shut gate means no output anywhere')
    assert.equal(tracingEnabled(), false)
    assert.equal(sharedTracer.file(), undefined)

    configureTracing({})
    sharedTracer.log('info', 'test', 'heard', { n: 2 })
    const events = sharedTracer.recent()
    assert.equal(events.length, 1)
    assert.equal(events[0]?.event, 'heard')
    assert.equal(tracingEnabled(), true)
  })

  it('rebinding the tracer starts a clean ring for the new enable cycle', () => {
    configureTracing({})
    sharedTracer.log('info', 'test', 'first-cycle', {})
    configureTracing({})
    assert.equal(sharedTracer.recent().length, 0, 'toggling resets the ring')
  })

  it('a file sink bound at configure time is reported through the gate', () => {
    const dir = freshDir()
    const file = join(dir, 'trace.ndjson')
    configureTracing({ file })
    assert.equal(sharedTracer.file(), file)
    shutdownTracing()
    assert.equal(sharedTracer.file(), undefined, 'no sink path while shut')
  })
})

describe('per-directory queue lock', () => {
  it('serializes separate queue instances sharing one directory', async () => {
    const dir = freshDir()
    const writer = createQueue({ dir })
    const reader = createQueue({ dir })

    // Two instances offering concurrently: both appends must survive, and the
    // second must see the first's entry in its dedupe pass.
    const results = await Promise.all([
      writer.offer({ text: '事实一', confidence: 0.9 }),
      reader.offer({ text: '事实二', confidence: 0.9 }),
    ])
    assert.ok(results.every((entry) => entry !== undefined), 'neither append is lost')

    const seen = await reader.list()
    assert.equal(seen.filter((entry) => entry.status === 'pending').length, 2)

    // And a duplicate offered through the other instance still dedupes.
    const duplicate = await writer.offer({ text: '事实一', confidence: 0.9 })
    assert.equal(duplicate, undefined, 'dedupe works across instances')
  })

  it('serializes a decision on one instance against an offer on another', async () => {
    const dir = freshDir()
    const capture = createQueue({ dir })
    const review = createQueue({ dir })

    const entry = await capture.offer({ text: '会并发的事实', confidence: 0.9 })
    assert.ok(entry !== undefined)

    // The race the lock exists for: capture appends while review rewrites.
    await Promise.all([
      capture.offer({ text: '另一个并发事实', confidence: 0.9 }),
      review.decide(entry.id, 'approved', { decidedBy: 'test' }),
    ])

    const final = await review.list()
    const approved = final.find((row) => row.id === entry.id)
    assert.equal(approved?.status, 'approved', 'the decision survives the concurrent append')
    assert.equal(final.filter((row) => row.status === 'pending').length, 1, 'and so does the new candidate')
  })
})
