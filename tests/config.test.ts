import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { Config as CoreConfig } from '../src/index.ts'
import { Config as RecallConfig } from '../src/recall-plugin.ts'
import { Config as CaptureConfig } from '../src/capture-plugin.ts'
import { Config as ReviewConfig } from '../src/review-plugin.ts'
import { Config as DebugConfig } from '../src/debug-plugin.ts'

// These assertions exist because schemastery substitutes defaults at parse time:
// an unset `z.array()` really does become `[]`, and a wrong assumption about
// that cost a released version on another plugin. Pin what an empty config
// actually yields per component instead of trusting the schema's shape.
describe('Config', () => {
  it('core leaves deployment values empty so credentials decide them', () => {
    const config = new CoreConfig({})
    assert.equal(config.baseUrl, '', 'the credential supplies the endpoint')
    assert.equal(config.userId, '', 'the credential supplies the owner id')
  })

  it('core accepts explicit deployment values', () => {
    const config = new CoreConfig({ baseUrl: 'http://127.0.0.1:8888', userId: 'someone' })
    assert.equal(config.baseUrl, 'http://127.0.0.1:8888')
    assert.equal(config.userId, 'someone')
  })

  it('recall turns brief and recall injection on by default', () => {
    const config = new RecallConfig({})
    assert.equal(config.brief, true)
    assert.equal(config.recall, true)
    const off = new RecallConfig({ brief: false })
    assert.equal(off.brief, false)
  })

  it('capture defaults to the design thresholds and a 7-day TTL', () => {
    const config = new CaptureConfig({})
    assert.equal(config.captureThreshold, 0.6)
    assert.equal(config.maxPerTurn, 5)
    assert.equal(config.pendingTtlDays, 7)
    assert.equal(config.pendingDir, '', '$DSH_HOME decides the queue location')
  })

  it('review defaults the dedupe threshold to 0.8', () => {
    const config = new ReviewConfig({})
    assert.equal(config.dedupeThreshold, 0.8)
  })

  it('debug defaults the file sink to off', () => {
    const config = new DebugConfig({})
    assert.equal(config.debugLog, false, 'a production run stays quiet by default')
  })
})
