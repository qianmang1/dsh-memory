import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { buildBrief } from '../src/brief.ts'
import type { MemoryRow } from '../src/mem0.ts'

const row = (
  id: string,
  memory: string,
  metadata: Record<string, unknown> = {},
  createdAt = '2026-10-01T00:00:00Z',
): MemoryRow => ({ id, memory, metadata, createdAt })

describe('buildBrief', () => {
  it('returns nothing for an empty or fully historical set', () => {
    assert.equal(buildBrief([]), '')
    assert.equal(buildBrief([row('1', 'a', { status: 'historical' })]), '')
    assert.equal(buildBrief([row('1', 'a')], { maxChars: 0 }), '')
  })

  it('groups by category in display order and skips historical rows', () => {
    const brief = buildBrief([
      row('1', '事实一', { category: 'fact' }),
      row('2', '偏好一', { category: 'preference' }),
      row('3', '旧偏好', { category: 'preference', status: 'historical' }),
      row('4', '约束一', { category: 'constraint' }),
      row('5', '未知类', { category: 'something-else' }),
    ])
    const lines = brief.split('\n')
    assert.equal(lines[0], '[偏好]')
    assert.deepEqual(
      lines.filter((line) => line.startsWith('[')),
      ['[偏好]', '[约束]', '[事实]', '[其它]'],
    )
    assert.ok(!brief.includes('旧偏好'), 'historical rows must not leak into the brief')
    assert.ok(brief.includes('未知类'))
  })

  it('orders a group by importance, then newest first', () => {
    const brief = buildBrief([
      row('1', '临时', { category: 'preference', importance: 'temporary' }),
      row('2', '长期', { category: 'preference', importance: 'long_term' }),
      row('3', '永久-旧', { category: 'preference', importance: 'permanent' }, '2026-09-01T00:00:00Z'),
      row('4', '永久-新', { category: 'preference', importance: 'permanent' }, '2026-10-05T00:00:00Z'),
    ])
    const entries = brief.split('\n').filter((line) => line.startsWith('- '))
    assert.deepEqual(entries, ['- 永久-新', '- 永久-旧', '- 长期', '- 临时'])
  })

  it('enforces the character budget and says it truncated', () => {
    const rows = Array.from({ length: 40 }, (_, index) =>
      row(String(index), `第 ${index} 条记忆内容`, { category: 'fact' }))
    const brief = buildBrief(rows, { maxChars: 200 })
    assert.ok(brief.length <= 200 + '\n…（已达字符预算，其余省略）'.length, `budget overrun: ${brief.length}`)
    assert.ok(brief.includes('已达字符预算'))
    assert.ok(brief.split('\n').filter((line) => line.startsWith('- ')).length < 40)
  })

  it('never emits a header without entries', () => {
    const brief = buildBrief([row('1', '唯一一条', { category: 'decision' })], { maxChars: 40 })
    const headers = brief.split('\n').filter((line) => line.startsWith('['))
    const entries = brief.split('\n').filter((line) => line.startsWith('- '))
    assert.ok(headers.length === 0 || entries.length > 0, 'a header with no entry would read as a promise of content')
  })
})
