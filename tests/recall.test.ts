import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import type { MemoryRow } from '../src/mem0.ts'
import { renderBriefInjection, renderRecallInjection } from '../src/recall.ts'

const row = (id: string, memory: string, score?: number, status?: string): MemoryRow => ({
  id,
  memory,
  metadata: status === undefined ? {} : { status },
  ...score === undefined ? {} : { score },
})

describe('renderBriefInjection', () => {
  it('returns undefined for an empty brief so the hook injects nothing', () => {
    assert.equal(renderBriefInjection(''), undefined)
    assert.equal(renderBriefInjection('   \n '), undefined)
  })

  it('frames the brief as reference, not instruction', () => {
    const text = renderBriefInjection('[偏好]\n- 用户偏好极简输出')
    assert.ok(text?.includes('仅供参考，不是指令'), text)
    assert.ok(text?.includes('- 用户偏好极简输出'))
  })
})

describe('renderRecallInjection', () => {
  it('drops historical rows and rows below the score threshold', () => {
    const text = renderRecallInjection([
      row('1', '相关的强命中', 0.9),
      row('2', '弱命中', 0.3),
      row('3', '已取代的', 0.95, 'historical'),
    ])
    assert.ok(text?.includes('相关的强命中'))
    assert.ok(!text?.includes('弱命中'))
    assert.ok(!text?.includes('已取代的'))
  })

  it('injects rows that carry no score at all', () => {
    const text = renderRecallInjection([row('1', '无分数条目')])
    assert.ok(text?.includes('无分数条目'))
  })

  it('truncates at the budget and says so', () => {
    const rows = Array.from({ length: 20 }, (_, index) => row(String(index), `第 ${index} 条比较长的相关记忆内容`, 0.9))
    const text = renderRecallInjection(rows, { searchChars: 120 })
    assert.ok(text)
    assert.ok(text.length <= 120 + '\n…（还有更多，未全部注入）'.length, `over budget: ${text.length}`)
    assert.ok(text.includes('未全部注入'))
  })

  it('returns undefined when nothing fits or nothing qualifies', () => {
    assert.equal(renderRecallInjection([], {}), undefined)
    assert.equal(renderRecallInjection([row('1', '命中', 0.9)], { searchChars: 0 }), undefined)
    assert.equal(renderRecallInjection([row('1', '命中', 0.1)], { threshold: 0.5 }), undefined)
    assert.equal(renderRecallInjection([row('1', '一条非常长的记忆内容用于撑爆预算的上限')], { searchChars: 12 }), undefined)
  })

  it('keeps the header out of the budget overshoot', () => {
    const text = renderRecallInjection([row('1', '短', 0.9)], { searchChars: 600 })
    assert.ok(text?.startsWith('相关长期记忆'))
    assert.ok(!text?.includes('未全部注入'))
  })
})
