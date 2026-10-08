/**
 * Skill registration — the memory-writing rules ship with the plugin.
 *
 * The body is a file (`skill/dsh-memory.md`), not a template literal: it is
 * prose that gets reviewed as prose, and keeping it byte-comparable with the
 * user-level copy it replaces is the point. The file is resolved relative to the
 * bundle, so a packaged install finds `<pkg>/skill/dsh-memory.md`.
 *
 * Registration is opportunistic (`ctx.get('skills')`): a host without a skills
 * service keeps every other capability instead of failing to mount.
 * @module dsh-memory/skill
 */

import { readFile } from 'node:fs/promises'

/** Skill name; the same name the user-level skill uses, so replacing it is a no-op for callers. */
export const SKILL_NAME = 'dsh-memory'
/** Registered provider name. */
export const SKILL_PROVIDER = 'dsh-memory'

/** Resolved against `lib/index.js`, which sits beside `skill/` in the package. */
const SKILL_BODY_URL = new URL('../skill/dsh-memory.md', import.meta.url)

const SKILL_DESCRIPTION = 'DSH 长期记忆管理规则：什么时候写入、什么禁止入库、如何检索、冲突如何处理、如何避免污染。当用户说“记住这个”“你还记得吗”“我的偏好是什么”，或需要写入/检索/纠正长期记忆时使用。'
const SKILL_WHEN_TO_USE = '写入、检索、纠正或审计长期记忆时；做出涉及用户既有偏好与历史决策的判断前。'
const SKILL_RANK = 100

/** Structural surface of `ctx.skills` this module needs; mirror of the host's provider contract. */
interface SkillServiceSurface {
  registerProvider(create: (control: {
    signal: { aborted: boolean; addEventListener(type: string, fn: () => void, opts?: unknown): void }
    invalidate(): void
  }) => {
    name: string
    list(options?: unknown): Promise<unknown>
    get(candidate: { name: string }, options?: unknown): Promise<unknown>
  }): unknown
}

/** The host surface this module touches; `Context` satisfies it. */
export interface SkillHost {
  get?(key: string): unknown
  logger?: { warn?(message: string): unknown }
}

/**
 * Read the shipped skill body.
 * @returns The markdown, or `undefined` when the package was built without it.
 */
export async function loadSkillBody(): Promise<string | undefined> {
  try {
    return await readFile(SKILL_BODY_URL, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Publish the memory rules when the host exposes a skills service.
 * @param ctx Host context (only `get` and an optional logger are used).
 * @param source Provenance suffix recorded on the summary.
 */
export function registerSkill(ctx: SkillHost, source: string): void {
  const skills = ctx.get?.('skills') as SkillServiceSurface | undefined
  if (typeof skills?.registerProvider !== 'function') return
  const summary = {
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    whenToUse: SKILL_WHEN_TO_USE,
    invocation: { modelInvocable: true, userInvocable: true },
    source: `custom#${source}`,
    provider: SKILL_PROVIDER,
    rank: SKILL_RANK,
  }
  try {
    skills.registerProvider(() => ({
      name: SKILL_PROVIDER,
      async list() {
        // No body means the package is incomplete; listing a skill whose content
        // cannot be read would hand the model an empty rule set.
        const body = await loadSkillBody()
        return body === undefined ? [] : [summary]
      },
      async get(candidate: { name: string }) {
        if (candidate?.name !== SKILL_NAME) return undefined
        const body = await loadSkillBody()
        return body === undefined ? undefined : { ...summary, content: body }
      },
    }))
  } catch (error) {
    ctx.logger?.warn?.(`dsh-memory: skill registration failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}
