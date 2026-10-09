import { S as createQueue, a as queueEventTrace, c as textOfBlocks, f as sharedTracer, g as activeBootReporter, s as resolvePendingDir, t as errorText } from "./runtime-Dj3ts4HE.js";
import z from "@deepseek-ai/schemastery";
//#region src/capture.ts
/** Questions never carry a fact worth storing; politeness never does either. */
const QUESTION_MARKERS = /[?？]|吗[。！!]?$|呢[。！!]?$/;
/** Openers that mean "this turn contained no assertion". */
const PLEASANTRY = /^(好的|好|嗯|谢谢|多谢|收到|明白|明白了|了解|了解啦|ok|okay|thanks|thank you)[。！!,.，\s]*$/i;
/** Vocabulary that distinguishes a durable fact from a task instruction. */
const FACT_VOCABULARY = /(偏好|喜欢|要求|希望|反对|必须|不要|禁止|习惯|总是|从不|约定|决定|采用|选择|使用|安装|部署|配置|规则|策略|原则|标准|术语|命名)/;
/** A subject makes the sentence about someone's standing state, not about this turn. */
const SUBJECT = /(我|用户|我们|团队|项目|你)/;
/** Evidence that the text is tool output or code rather than a statement. */
const CODE_OR_PATH = /(```|^\s*[$>#]\s|\/[\w.-]+\/[\w.-]+|[A-Za-z]:\\|\.(ts|tsx|js|mjs|json|yaml|yml|md|py|rs)\b)/;
/** Split a message into sentence-ish units on newlines and CJK/Latin terminators. */
function splitSentences(text) {
	return text.split(/[\n\r]+|(?<=[。！!？?；;])/u).map((part) => part.trim()).filter((part) => part.length > 0);
}
/**
* Score one sentence as a storable fact.
* @param sentence Candidate sentence.
* @returns Confidence in `[0, 1]`; the design's admission threshold is 0.6.
*/
function scoreCandidate(sentence) {
	const text = sentence.trim();
	if (text.length === 0) return 0;
	if (PLEASANTRY.test(text)) return .05;
	if (QUESTION_MARKERS.test(text)) return .15;
	if (text.includes("```")) return .1;
	let score = 0;
	if (text.length >= 10 && text.length <= 120) score += .2;
	if (text.length < 8) score -= .3;
	if (text.length > 200) score -= .1;
	if (SUBJECT.test(text)) score += .2;
	if (FACT_VOCABULARY.test(text)) score += .25;
	if (CODE_OR_PATH.test(text)) score -= .25;
	if (/[。.]$/.test(text) || !/[！!]$/.test(text)) score += .15;
	if (/[！!]$/.test(text)) score -= .05;
	return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}
/**
* Admit the storable sentences from one turn.
* @param texts Message texts for the turn (user text first is conventional).
* @param options Threshold, per-turn cap, and the longest sentence considered.
* @returns Candidates ordered by score, deduplicated on normalized text.
*/
function extractCandidates(texts, options = {}) {
	const threshold = options.threshold ?? .6;
	const maxPerTurn = options.maxPerTurn ?? 5;
	const maxChars = options.maxChars ?? 200;
	const seen = /* @__PURE__ */ new Set();
	const admitted = [];
	for (const text of texts) for (const sentence of splitSentences(text)) {
		if (sentence.length > maxChars) continue;
		const confidence = scoreCandidate(sentence);
		if (confidence < threshold) continue;
		const key = sentence.replace(/[\s\p{P}\p{S}]+/gu, "").toLowerCase();
		if (key.length === 0 || seen.has(key)) continue;
		seen.add(key);
		admitted.push({
			text: sentence,
			confidence
		});
	}
	return admitted.sort((left, right) => right.confidence - left.confidence).slice(0, maxPerTurn);
}
//#endregion
//#region src/capture-plugin.ts
const name = "memory-capture";
const Config = z.object({
	pendingDir: z.string().default(""),
	captureThreshold: z.number().default(.6),
	maxPerTurn: z.number().default(5),
	pendingTtlDays: z.number().default(7)
});
/**
* Mount the capture component.
* @param ctx Host context; hook registrations are effects scoped to it.
* @param config Resolved component configuration.
*/
function apply(ctx, config) {
	const pendingDir = resolvePendingDir(config);
	const ttlDays = config.pendingTtlDays ?? 7;
	const threshold = config.captureThreshold ?? .6;
	const maxPerTurn = config.maxPerTurn ?? 5;
	const queue = createQueue({
		dir: pendingDir,
		ttlDays,
		onEvent: queueEventTrace
	});
	const turnTexts = /* @__PURE__ */ new Map();
	ctx.on("agent/pre-step", async ({ agent, messages }, next) => {
		const texts = messages.flatMap((message) => textOfBlocks(message.content));
		turnTexts.set(String(agent.session.header.id), texts);
		sharedTracer.log("debug", "hook", "prestep.texts", {
			session: String(agent.session.header.id).slice(0, 8),
			messages: messages.length,
			chars: texts.join("").length
		});
		return next();
	});
	ctx.on("agent/turn-stopping", async ({ agent }) => {
		const key = String(agent.session.header.id);
		const texts = turnTexts.get(key);
		turnTexts.delete(key);
		if (texts === void 0 || texts.length === 0) {
			sharedTracer.log("debug", "hook", "capture.skip", { reason: "no-turn-texts" });
			return;
		}
		const candidates = extractCandidates(texts, {
			threshold,
			maxPerTurn
		});
		if (candidates.length === 0) {
			sharedTracer.log("info", "hook", "capture.skip", {
				reason: "below-threshold",
				messages: texts.length
			});
			return;
		}
		try {
			await queue.expire();
			let offered = 0;
			for (const candidate of candidates) if (await queue.offer({
				text: candidate.text,
				confidence: candidate.confidence,
				sourceSession: key
			}) !== void 0) offered += 1;
			sharedTracer.log("info", "hook", "capture.done", {
				candidates: candidates.length,
				offered,
				duplicates: candidates.length - offered,
				session: key.slice(0, 8)
			});
		} catch (error) {
			sharedTracer.log("warn", "hook", "capture.error", { error: errorText(error).slice(0, 200) });
		}
	});
	const boot = activeBootReporter();
	const warnings = [];
	if (threshold < 0 || threshold > 1) warnings.push(`captureThreshold=${threshold} 超出 [0,1]`);
	if (ttlDays <= 0) warnings.push(`pendingTtlDays=${config.pendingTtlDays} 非正数，候选永不过期`);
	if (maxPerTurn < 1) warnings.push(`maxPerTurn=${maxPerTurn} 小于 1`);
	boot?.report("capture-config", warnings.length > 0 ? "warn" : "ok", `threshold=${threshold} maxPerTurn=${maxPerTurn} ttl=${ttlDays}d` + (warnings.length > 0 ? `；${warnings.join("；")}` : ""));
	boot?.report("capture", "ok", `候审队列 ${pendingDir}`);
}
//#endregion
export { Config, apply, name };
