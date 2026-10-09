import { readFile } from "node:fs/promises";
//#region src/skill.ts
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
/** Skill name; the same name the user-level skill uses, so replacing it is a no-op for callers. */
const SKILL_NAME = "dsh-memory";
/** Registered provider name. */
const SKILL_PROVIDER = "dsh-memory";
/** Resolved against `lib/index.js`, which sits beside `skill/` in the package. */
const SKILL_BODY_URL = new URL("../skill/dsh-memory.md", import.meta.url);
const SKILL_DESCRIPTION = "DSH 长期记忆管理规则：什么时候写入、什么禁止入库、如何检索、冲突如何处理、如何避免污染。当用户说“记住这个”“你还记得吗”“我的偏好是什么”，或需要写入/检索/纠正长期记忆时使用。";
const SKILL_WHEN_TO_USE = "写入、检索、纠正或审计长期记忆时；做出涉及用户既有偏好与历史决策的判断前。";
const SKILL_RANK = 100;
/**
* Read the shipped skill body.
* @returns The markdown, or `undefined` when the package was built without it.
*/
async function loadSkillBody() {
	try {
		return await readFile(SKILL_BODY_URL, "utf8");
	} catch {
		return;
	}
}
/**
* Publish the memory rules when the host exposes a skills service.
* @param ctx Host context (only `get` and an optional logger are used).
* @param source Provenance suffix recorded on the summary.
* @returns What happened, for the boot self-check report.
*/
function registerSkill(ctx, source) {
	const skills = ctx.get?.("skills");
	if (typeof skills?.registerProvider !== "function") return {
		state: "skip",
		detail: "宿主未提供 skills 服务"
	};
	const summary = {
		name: SKILL_NAME,
		description: SKILL_DESCRIPTION,
		whenToUse: SKILL_WHEN_TO_USE,
		invocation: {
			modelInvocable: true,
			userInvocable: true
		},
		source: `custom#${source}`,
		provider: SKILL_PROVIDER,
		rank: SKILL_RANK
	};
	try {
		skills.registerProvider(() => ({
			name: SKILL_PROVIDER,
			async list() {
				return await loadSkillBody() === void 0 ? [] : [summary];
			},
			async get(candidate) {
				if (candidate?.name !== "dsh-memory") return void 0;
				const body = await loadSkillBody();
				return body === void 0 ? void 0 : {
					...summary,
					content: body
				};
			}
		}));
		return {
			state: "ok",
			detail: `技能 ${SKILL_NAME} 已注册（provider ${SKILL_PROVIDER}）`
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		ctx.logger?.warn?.(`dsh-memory: skill registration failed: ${reason}`);
		return {
			state: "fail",
			detail: `注册失败：${reason}`
		};
	}
}
//#endregion
export { registerSkill as n, loadSkillBody as t };
