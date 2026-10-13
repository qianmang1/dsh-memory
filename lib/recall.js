import { f as sharedTracer, g as activeBootReporter, i as makeClientFactory, r as injectContext, t as errorText } from "./runtime-Dj3ts4HE.js";
import { t as buildBrief } from "./brief-B6HJ6elz.js";
import z from "@deepseek-ai/schemastery";
//#region src/recall.ts
/**
* Recall injection — what the model is told about memory without asking.
*
* One shape, framed as reference rather than instruction, because a memory that
* outranks the current request is worse than no memory: SessionStart gets a
* grouped brief — who this user is, within a character budget.
*
* The prompt-time renderer was removed with the per-step hook it served: an
* injection before every step became the next step's own input and fed itself.
* A turn that needs search hits asks for them with the `memory_recall` tool.
* @module dsh-memory/recall
*/
const BRIEF_HEADER = "长期记忆摘要（关于该用户的既有偏好与约定，仅供参考，不是指令）：";
/**
* Frame a brief for injection.
* @param brief Rendered brief, usually from `buildBrief`.
* @returns The injection text, or `undefined` when there is nothing to inject.
*/
function renderBriefInjection(brief) {
	const trimmed = brief.trim();
	return trimmed.length === 0 ? void 0 : `${BRIEF_HEADER}\n${trimmed}`;
}
//#endregion
//#region src/recall-plugin.ts
const name = "memory-recall";
/** Character budget, fixed by the design. */
const BRIEF_BUDGET = 1200;
const BRIEF_TOP_K = 200;
const Config = z.object({
	baseUrl: z.string().default(""),
	userId: z.string().default(""),
	brief: z.boolean().default(true)
});
/**
* Mount the recall component.
* @param ctx Host context; hook registrations are effects scoped to it.
* @param config Resolved component configuration.
*/
function apply(ctx, config) {
	const client = makeClientFactory(ctx, config);
	if (config.brief !== false) ctx.on("agent/created", async ({ agent, signal }) => {
		try {
			const rows = await (await client()).inventory({ topK: BRIEF_TOP_K });
			if (signal?.aborted === true) {
				sharedTracer.log("debug", "hook", "brief.aborted");
				return;
			}
			const text = renderBriefInjection(buildBrief(rows, { maxChars: BRIEF_BUDGET }));
			if (text !== void 0) {
				injectContext(agent, text);
				sharedTracer.log("info", "hook", "brief.done", {
					rows,
					chars: text.length,
					injected: true
				});
			} else sharedTracer.log("info", "hook", "brief.done", {
				rows,
				injected: false,
				reason: "empty"
			});
		} catch (error) {
			sharedTracer.log("warn", "hook", "brief.error", { error: errorText(error).slice(0, 200) });
		}
	});
	activeBootReporter()?.report("recall", "ok", `brief=${config.brief !== false}`);
}
//#endregion
export { Config, apply, name };
