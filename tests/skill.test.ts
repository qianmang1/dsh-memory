import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { loadSkillBody, registerSkill, SKILL_NAME } from '../src/skill.ts'

interface Published {
  name: string
  list(): Promise<Array<{ name: string; source: string }>>
  get(candidate: { name: string }): Promise<{ name: string; content: string } | undefined>
}

/** A skills service double that hands back the provider the plugin registered. */
function skillsHost(): { host: { get(key: string): unknown }; published: Published[] } {
  const published: Published[] = []
  const host = {
    get(key: string) {
      if (key !== 'skills') return undefined
      return {
        registerProvider(create: (control: unknown) => Published) {
          published.push(create({ signal: { aborted: false, addEventListener() {} }, invalidate() {} }))
          return undefined
        },
      }
    },
  }
  return { host, published }
}

describe('skill registration', () => {
  it('ships the writing rules with the package', async () => {
    const body = await loadSkillBody()
    assert.ok(body, 'the body must be readable from the package')
    assert.match(body, /validate 六问/)
    assert.match(body, /memory_remember/, 'the mapping table must name the tools this plugin actually provides')
    assert.ok(!body.includes('memory_store'), 'a stale tool name would send the model to a tool that does not exist')
  })

  it('publishes exactly one skill carrying that body', async () => {
    const { host, published } = skillsHost()
    registerSkill(host, 'dsh-memory')
    assert.equal(published.length, 1)
    const provider = published[0]
    assert.ok(provider)
    assert.equal(provider.name, 'dsh-memory')

    const list = await provider.list()
    assert.equal(list.length, 1)
    assert.equal(list[0]?.name, SKILL_NAME)
    assert.match(list[0]?.source ?? '', /custom#dsh-memory/)

    const skill = await provider.get({ name: SKILL_NAME })
    assert.ok(skill)
    assert.match(skill.content, /记错比不记更糟/)
  })

  it('returns nothing for an unknown skill name', async () => {
    const { host, published } = skillsHost()
    registerSkill(host, 'dsh-memory')
    assert.equal(await published[0]?.get({ name: 'some-other-skill' }), undefined)
  })

  it('is a no-op on a host without a skills service', () => {
    assert.doesNotThrow(() => { registerSkill({}, 'test') })
    assert.doesNotThrow(() => { registerSkill({ get: () => undefined }, 'test') })
  })
})
