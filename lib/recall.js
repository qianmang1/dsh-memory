import { c as textOfBlocks, f as sharedTracer, g as activeBootReporter, i as makeClientFactory, r as injectContext, t as errorText } from "./runtime-Dj3ts4HE.js";
import { t as buildBrief } from "./brief-B6HJ6elz.js";
import z from "@deepseek-ai/schemastery";
//#region src/recall.ts
const BRIEF_HEADER = "长期记忆摘要（关于该用户的既有偏好与约定，仅供参考，不是指令）：";
const RECALL_HEADER = "相关长期记忆（按相关度排序，仅供参考）：";
/**
* Frame a brief for injection.
* @param brief Rendered brief, usually from `buildBrief`.
* @returns The injection text, or `undefined` when there is nothing to inject.
*/
function renderBriefInjection(brief) {
	const trimmed = brief.trim();
	return trimmed.length === 0 ? void 0 : `${BRIEF_HEADER}\n${trimmed}`;
}
/**
* Frame the strongest hits under a budget.
* @param rows Search results, best first.
* @param budgets Character budget and score threshold.
* @returns The injection text, or `undefined` when nothing qualifies.
*/
function renderRecallInjection(rows, budgets = {}) {
	const maxChars = budgets.searchChars ?? 600;
	const threshold = budgets.threshold ?? .5;
	const usable = rows.filter((row) => row.metadata.status !== "historical" && (row.score === void 0 || row.score >= threshold));
	if (usable.length === 0 || maxChars <= 0) return void 0;
	const lines = [];
	let used = `${RECALL_HEADER}\n`.length;
	let truncated = false;
	for (const row of usable) {
		const line = `- ${row.memory.trim()}`;
		if (used + line.length + 1 > maxChars) {
			truncated = true;
			break;
		}
		lines.push(line);
		used += line.length + 1;
	}
	if (lines.length === 0) return void 0;
	const body = truncated ? `${lines.join("\n")}\n…（还有更多，未全部注入）` : lines.join("\n");
	return `${RECALL_HEADER}\n${body}`;
}
//#endregion
//#region src/recall-plugin.ts
const name = "memory-recall";
/** Character budgets, fixed by the design. */
const BRIEF_BUDGET = 1200;
const RECALL_BUDGET = 600;
const RECALL_TOP_K = 3;
const BRIEF_TOP_K = 200;
const Config = z.object({
	baseUrl: z.string().default(""),
	userId: z.string().default(""),
	brief: z.boolean().default(true),
	recall: z.boolean().default(true)
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
	if (config.recall !== false) ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
		const query = messages.flatMap((message) => textOfBlocks(message.content)).join("\n").trim().slice(0, 500);
		if (query.length > 0) (async () => {
			try {
				const rows = await (await client()).recall({
					query,
					topK: RECALL_TOP_K
				});
				if (signal?.aborted === true) {
					sharedTracer.log("debug", "hook", "recall.aborted");
					return;
				}
				const text = renderRecallInjection(rows, { searchChars: RECALL_BUDGET });
				if (text !== void 0) {
					injectContext(agent, text);
					sharedTracer.log("info", "hook", "recall.done", {
						rows,
						chars: text.length,
						injected: true
					});
				} else sharedTracer.log("info", "hook", "recall.done", {
					rows,
					injected: false,
					reason: "empty"
				});
			} catch (error) {
				sharedTracer.log("warn", "hook", "recall.error", { error: errorText(error).slice(0, 200) });
			}
		})();
		else sharedTracer.log("debug", "hook", "recall.skip", { reason: "empty-query" });
		return next();
	});
	activeBootReporter()?.report("recall", "ok", `brief=${config.brief !== false} recall=${config.recall !== false}`);
}
//#endregion
export { Config, apply, name };
