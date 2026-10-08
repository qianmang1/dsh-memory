import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { Config } from '../src/index.ts'

// These assertions exist because schemastery substitutes defaults at parse time:
// an unset `z.array()` really does become `[]`, and a wrong assumption about
// that cost a released version on another plugin. Pin what an empty config
// actually yields instead of trusting the schema's shape.
describe('Config', () => {
  it('turns recall/capture on and defaults the pending TTL to 7 days', () => {
    const config = new Config({})
    assert.equal(config.recall, true)
    assert.equal(config.capture, true)
    assert.equal(config.pendingTtlDays, 7)
  })

  it('leaves deployment values empty so credentials and $DSH_HOME decide them', () => {
    const config = new Config({})
    assert.equal(config.baseUrl, '', 'the credential supplies the endpoint')
    assert.equal(config.userId, '', 'the credential supplies the owner id')
    assert.equal(config.pendingDir, '', '$DSH_HOME decides the queue location')
  })

  it('accepts explicit deployment values', () => {
    const config = new Config({ baseUrl: 'http://127.0.0.1:8888', userId: 'someone', recall: false })
    assert.equal(config.baseUrl, 'http://127.0.0.1:8888')
    assert.equal(config.userId, 'someone')
    assert.equal(config.recall, false)
  })
})
