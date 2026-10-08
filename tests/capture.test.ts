import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { extractCandidates, scoreCandidate, splitSentences } from '../src/capture.ts'

describe('scoreCandidate', () => {
  it('scores a declarative fact about the user above the admission threshold', () => {
    assert.ok(scoreCandidate('用户偏好极简的中文输出。') >= 0.6)
    assert.ok(scoreCandidate('用户要求所有报告区分事实与推测。') >= 0.6)
  })

  it('keeps questions, pleasantries, and code out of the queue', () => {
    assert.ok(scoreCandidate('这个工具怎么配置？') < 0.6)
    assert.ok(scoreCandidate('好的，谢谢！') < 0.6)
    assert.ok(scoreCandidate('```ts\nconst x = 1\n```') < 0.6)
    assert.ok(scoreCandidate('C:\\Users\\Y\\file.ts 里改一处') < 0.6)
  })

  it('rewards the signals it claims to reward', () => {
    const bare = scoreCandidate('这句话没有任何事实词。')
    const factual = scoreCandidate('用户要求这句话使用事实词。')
    assert.ok(factual > bare, `expected ${factual} > ${bare}`)
    assert.ok(scoreCandidate('') === 0)
  })

  it('treats a very short fragment as noise', () => {
    assert.ok(scoreCandidate('改了') < 0.6)
  })
})

describe('splitSentences', () => {
  it('splits on newlines and sentence terminators', () => {
    assert.deepEqual(splitSentences('第一句。第二句！\n第三句'), ['第一句。', '第二句！', '第三句'])
    assert.deepEqual(splitSentences('   \n\n  '), [])
  })
})

describe('extractCandidates', () => {
  it('admits facts and drops everything else from one turn', () => {
    const candidates = extractCandidates([
      '帮我看看这个报错？\n用户偏好极简的中文输出。\n好的，谢谢！\n用户要求所有报告区分事实与推测。',
    ])
    assert.deepEqual(candidates.map((c) => c.text), [
      '用户偏好极简的中文输出。',
      '用户要求所有报告区分事实与推测。',
    ])
    for (const candidate of candidates) assert.ok(candidate.confidence >= 0.6)
  })

  it('caps a turn at five candidates, keeping the highest scores', () => {
    const texts = Array.from({ length: 9 }, (_, index) => `用户偏好第 ${index} 种极简实施方案。`)
    const candidates = extractCandidates(texts)
    assert.equal(candidates.length, 5, 'the per-turn cap is what keeps a noisy turn from flooding review')
    assert.ok(candidates[0]!.confidence >= candidates[4]!.confidence)
  })

  it('deduplicates on normalized text', () => {
    const candidates = extractCandidates(['用户偏好极简方案。', '用户偏好极简方案！', '用户偏好极简方案'])
    assert.equal(candidates.length, 1)
  })

  it('skips sentences longer than the prose limit', () => {
    const long = `用户要求${'很长'.repeat(120)}。`
    assert.equal(extractCandidates([long]).length, 0)
  })

  it('honours an explicit threshold and cap', () => {
    const texts = ['用户偏好极简方案。', '用户要求区分事实与推测。']
    assert.equal(extractCandidates(texts, { threshold: 0.95 }).length, 0)
    assert.equal(extractCandidates(texts, { maxPerTurn: 1 }).length, 1)
  })

  it('returns nothing for an empty turn', () => {
    assert.deepEqual(extractCandidates([]), [])
    assert.deepEqual(extractCandidates(['   \n  ']), [])
  })
})
