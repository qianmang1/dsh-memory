import { homedir } from "node:os";
import { join } from "node:path";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { credentialRef, isCredentialRefName } from "@deepseek-ai/dsh-credentials";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/brief.ts
/** Display order and labels; an unknown category lands in the trailing group. */
const CATEGORY_LABELS = [
	["preference", "偏好"],
	["constraint", "约束"],
	["goal", "目标"],
	["decision", "决策"],
	["workflow", "工作流"],
	["project", "项目"],
	["fact", "事实"],
	["person", "人物"],
	["relation", "关系"]
];
const OTHER_LABEL = "其它";
/** Lower sorts first inside a group. */
function importanceRank(importance) {
	if (importance === "permanent") return 0;
	if (importance === "long_term") return 1;
	if (importance === "temporary") return 2;
	return 1.5;
}
/**
* Render memory rows as a grouped brief, newest-and-most-important first inside
* each group, stopping at the character budget.
* @param rows Rows in any order; the function sorts them.
* @param options Budget and historical inclusion.
* @returns The brief, or an empty string when there is nothing to say.
*/
function buildBrief(rows, options = {}) {
	const maxChars = options.maxChars ?? 1200;
	const usable = rows.filter((row) => options.includeHistorical === true || row.metadata.status !== "historical");
	if (usable.length === 0 || maxChars <= 0) return "";
	const groupOrder = CATEGORY_LABELS.map(([category]) => category);
	const grouped = /* @__PURE__ */ new Map();
	for (const row of usable) {
		const category = row.metadata.category ?? OTHER_LABEL;
		const key = groupOrder.includes(category) ? category : OTHER_LABEL;
		const bucket = grouped.get(key);
		if (bucket === void 0) grouped.set(key, [row]);
		else bucket.push(row);
	}
	for (const bucket of grouped.values()) bucket.sort((left, right) => {
		const byImportance = importanceRank(left.metadata.importance) - importanceRank(right.metadata.importance);
		if (byImportance !== 0) return byImportance;
		return (right.createdAt ?? "").localeCompare(left.createdAt ?? "");
	});
	const labelOf = (key) => key === OTHER_LABEL ? OTHER_LABEL : CATEGORY_LABELS.find(([category]) => category === key)?.[1] ?? OTHER_LABEL;
	const lines = [];
	let used = 0;
	let truncated = false;
	const keys = [...groupOrder.filter((key) => grouped.has(key)), ...grouped.has(OTHER_LABEL) ? [OTHER_LABEL] : []];
	for (const key of keys) {
		const header = `[${labelOf(key)}]`;
		const entries = grouped.get(key) ?? [];
		const body = [];
		let headerWritten = false;
		for (const row of entries) {
			const line = `- ${row.memory.trim()}`;
			const pending = (headerWritten ? 0 : `${header}\n`.length) + `${line}\n`.length;
			if (used + pending > maxChars) {
				truncated = true;
				break;
			}
			if (!headerWritten) {
				lines.push(header);
				used += `${header}\n`.length;
				headerWritten = true;
			}
			body.push(line);
			used += `${line}\n`.length;
		}
		lines.push(...body);
		if (truncated) break;
	}
	if (lines.length === 0) return "";
	const text = lines.join("\n");
	return truncated ? `${text}\n…（已达字符预算，其余省略）` : text;
}
//#endregion
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
//#region src/credentials.ts
/**
* mem0 credential resolution.
*
* The API key never appears in plugin config: it is read per operation through
* `ctx.credentials`, which layers the process environment, `.env` files, and
* the provider-managed store. Resolution is per call by contract — caching a
* key across operations would keep a rotated credential invisible until the
* next restart.
* @module dsh-memory/credentials
*/
/** Credential refs; the same names the Python MCP bridge reads, so migration needs no environment change. */
const MEM0_API_KEY_REF = "MEM0_API_KEY";
const MEM0_BASE_URL_REF = "MEM0_BASE_URL";
const MEM0_USER_ID_REF = "MEM0_USER_ID";
/**
* Resolve the endpoint, key, and owner for one operation.
* @param ctx Host context; `ctx.get('credentials')` is read opportunistically so a host without the service degrades to a clear error rather than a load failure.
* @param config Plugin config values that override the credential layer.
* @returns The resolved triple.
* @throws Error naming every missing value and where to configure it.
*/
async function resolveMem0Credentials(ctx, config) {
	const reader = ctx.get("credentials");
	const read = async (ref) => {
		if (reader === void 0 || !isCredentialRefName(ref)) return void 0;
		return (await reader.resolve(credentialRef(ref)))?.value;
	};
	const baseUrl = config.baseUrl?.trim() || await read("MEM0_BASE_URL");
	const apiKey = await read(MEM0_API_KEY_REF);
	const userId = config.userId?.trim() || await read("MEM0_USER_ID");
	if (!baseUrl || !apiKey || !userId) {
		const missing = [];
		if (!baseUrl) missing.push(`baseUrl（插件配置或 ${MEM0_BASE_URL_REF} 凭据）`);
		if (!apiKey) missing.push(`${MEM0_API_KEY_REF} 凭据`);
		if (!userId) missing.push(`userId（插件配置或 ${MEM0_USER_ID_REF} 凭据）`);
		const hint = reader === void 0 ? "宿主未提供 credentials 服务，请改用插件配置或进程环境变量。" : "把值写入 ~/.dsh/.credentials.yaml 或进程环境变量后重试。";
		throw new Error(`dsh-memory: 缺少 ${missing.join("、")}。${hint}`);
	}
	return {
		baseUrl: baseUrl.replace(/\/+$/, ""),
		apiKey,
		userId
	};
}
//#endregion
//#region src/mem0.ts
/** A mem0 call that failed, classified by what the caller can do about it. */
var Mem0Error = class extends Error {
	/** Which failure class this is. */
	kind;
	/** HTTP status when one was received. */
	status;
	constructor(message, kind, status) {
		super(message);
		this.name = "Mem0Error";
		this.kind = kind;
		if (status !== void 0) this.status = status;
	}
};
const DEFAULT_TIMEOUT_MS = 15e3;
/** Map one service row into the narrow shape callers use. */
function toMemoryRow(raw) {
	if (typeof raw !== "object" || raw === null) return void 0;
	const row = raw;
	const id = typeof row["id"] === "string" ? row["id"] : void 0;
	const memory = typeof row["memory"] === "string" ? row["memory"] : void 0;
	if (id === void 0 || memory === void 0) return void 0;
	const metadata = typeof row["metadata"] === "object" && row["metadata"] !== null ? row["metadata"] : {};
	const hash = typeof row["hash"] === "string" ? row["hash"] : void 0;
	const createdAt = typeof row["created_at"] === "string" ? row["created_at"] : void 0;
	const updatedAt = typeof row["updated_at"] === "string" ? row["updated_at"] : void 0;
	const score = typeof row["score"] === "number" ? row["score"] : void 0;
	return {
		id,
		memory,
		metadata,
		...hash === void 0 ? {} : { hash },
		...createdAt === void 0 ? {} : { createdAt },
		...updatedAt === void 0 ? {} : { updatedAt },
		...score === void 0 ? {} : { score }
	};
}
/** Unwrap the `{results:[…]}` envelope; a bare array is accepted too. */
function toRows(payload) {
	return (Array.isArray(payload) ? payload : typeof payload === "object" && payload !== null && Array.isArray(payload.results) ? payload.results : []).map(toMemoryRow).filter((row) => row !== void 0);
}
/** Client-side filter that mirrors the semantics the Python bridge applied after searching. */
function filterRows(rows, options) {
	return rows.filter((row) => {
		if (options.includeHistorical !== true && row.metadata.status === "historical") return false;
		if (options.category !== void 0 && row.metadata.category !== options.category) return false;
		if (options.scope !== void 0 && row.metadata.scope !== options.scope) return false;
		return true;
	});
}
/**
* Build the client over one resolved credential triple.
* @param options Endpoint, key, owner, and test seams.
* @returns The client.
*/
function createMem0Client(options) {
	const doFetch = options.fetchImpl ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const request = async (method, path, body) => {
		const url = `${options.baseUrl}${path}`;
		let response;
		try {
			response = await doFetch(url, {
				method,
				headers: {
					"X-API-Key": options.apiKey,
					"Content-Type": "application/json"
				},
				...body === void 0 ? {} : { body: JSON.stringify(body) },
				signal: AbortSignal.timeout(timeoutMs)
			});
		} catch (error) {
			throw new Mem0Error(`dsh-memory: mem0 请求失败（网络）: ${method} ${path} — ${error instanceof Error ? error.message : String(error)}`, "network");
		}
		const text = await response.text();
		if (!response.ok) {
			const detail = text.slice(0, 500);
			const kind = response.status === 401 || response.status === 403 ? "auth" : response.status >= 500 ? "server" : "client";
			throw new Mem0Error(`dsh-memory: mem0 ${method} ${path} -> HTTP ${response.status}: ${detail}`, kind, response.status);
		}
		if (text.trim().length === 0) return {};
		try {
			return JSON.parse(text);
		} catch (error) {
			throw new Mem0Error(`dsh-memory: mem0 返回了非 JSON 响应: ${method} ${path} — ${error instanceof Error ? error.message : String(error)}`, "server");
		}
	};
	return {
		async recall(input) {
			return filterRows(toRows(await request("POST", "/search", {
				query: input.query,
				user_id: options.userId,
				top_k: input.topK ?? 10
			})), {
				...input.category === void 0 ? {} : { category: input.category },
				...input.scope === void 0 ? {} : { scope: input.scope },
				...input.includeHistorical === void 0 ? {} : { includeHistorical: input.includeHistorical }
			});
		},
		async inventory(input = {}) {
			const params = new URLSearchParams({
				user_id: options.userId,
				top_k: String(input.topK ?? 50)
			});
			return toRows(await request("GET", `/memories?${params.toString()}`)).filter((row) => {
				if (input.category !== void 0 && row.metadata.category !== input.category) return false;
				if (input.status !== void 0 && (row.metadata.status ?? "current") !== input.status) return false;
				if (input.scope !== void 0 && row.metadata.scope !== input.scope) return false;
				if (input.importance !== void 0 && row.metadata.importance !== input.importance) return false;
				return true;
			});
		},
		async read(id) {
			return toMemoryRow(await request("GET", `/memories/${encodeURIComponent(id)}`));
		},
		async remember(input) {
			return toRows(await request("POST", "/memories", {
				user_id: options.userId,
				messages: [{
					role: "user",
					content: input.text
				}],
				metadata: input.metadata ?? {},
				infer: input.infer ?? false
			}));
		},
		async supersede(input) {
			const old = toMemoryRow(await request("GET", `/memories/${encodeURIComponent(input.oldId)}`));
			const supersededId = old?.id ?? input.oldId;
			const keep = {};
			if (old?.metadata.category !== void 0) keep.category = old.metadata.category;
			if (old?.metadata.scope !== void 0) keep.scope = old.metadata.scope;
			if (old?.metadata.importance !== void 0) keep.importance = old.metadata.importance;
			if (old?.metadata.project !== void 0) keep.project = old.metadata.project;
			if (old?.metadata.source !== void 0) keep.source = old.metadata.source;
			if (old?.metadata.tags !== void 0) keep.tags = old.metadata.tags;
			await request("PUT", `/memories/${encodeURIComponent(supersededId)}`, {
				text: old?.memory ?? "superseded",
				metadata: {
					...keep,
					status: "historical"
				}
			});
			return {
				supersededId,
				created: toRows(await request("POST", "/memories", {
					user_id: options.userId,
					messages: [{
						role: "user",
						content: input.text
					}],
					metadata: {
						...input.metadata,
						status: "current",
						supersedes: supersededId,
						...input.source === void 0 ? {} : { source: input.source }
					},
					infer: false
				}))
			};
		}
	};
}
//#endregion
//#region src/queue.ts
/**
* Pending-review queue — the file layer between "candidate fact" and "stored
* memory".
*
* Two write paths, chosen for the failure they can have:
* - A new candidate is **appended** as one JSONL line. Concurrent appends from
*   several sessions interleave without losing each other, and an interrupted
*   write leaves at most one malformed trailing line.
* - A status change rewrites the whole file through a temp file and a rename,
*   because the line that changes is not the line being added. That is not
*   concurrency-safe across processes by itself, so it is serialized in-process
*   and the state machine is idempotent: a lost race costs one transition, not
*   a corrupted queue.
*
* `pending.md` is a derived view, never a source: approving by editing the
* markdown would put the decision where no read path looks.
* @module dsh-memory/queue
*/
/** Normalize text for dedupe: case, whitespace, and punctuation all stop mattering. */
function normalizeText(text) {
	return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}
/** Local dedupe key; deliberately not the service's hash, which is computed server-side. */
function hashText(text) {
	return createHash("sha256").update(normalizeText(text)).digest("hex").slice(0, 32);
}
/** Render the derived markdown view; ids are shortened for human reference only. */
function renderMarkdown(entries) {
	const sections = [
		["待审", "pending"],
		["已批准", "approved"],
		["已驳回", "dismissed"],
		["已过期", "expired"]
	];
	const lines = [
		"# 记忆候审队列",
		"",
		"> 由 pending.jsonl 生成，勿手工编辑；批准与驳回在侧边栏或 memory_review 里做。",
		""
	];
	for (const [title, status] of sections) {
		const rows = entries.filter((entry) => entry.status === status);
		if (rows.length === 0) continue;
		lines.push(`## ${title} ${rows.length}`, "");
		for (const entry of rows) {
			const facts = [
				entry.metadata.category,
				entry.metadata.scope,
				entry.metadata.importance
			].filter((value) => value !== void 0);
			const suffix = facts.length === 0 ? "" : `（${facts.join(" · ")}）`;
			lines.push(`- [${entry.id.slice(0, 6)}] ${entry.text}${suffix} conf ${entry.confidence.toFixed(2)}`);
			const detail = [
				entry.evidence === void 0 ? void 0 : `证据：${entry.evidence}`,
				`时间：${entry.created_at}`,
				entry.supersedes === void 0 ? void 0 : `取代：${entry.supersedes.slice(0, 8)}`,
				entry.stored_memory_id === void 0 ? void 0 : `mem0：${entry.stored_memory_id.slice(0, 8)}`
			].filter((value) => value !== void 0);
			if (detail.length > 0) lines.push(`  ${detail.join(" · ")}`);
		}
		lines.push("");
	}
	if (entries.length === 0) lines.push("（队列为空）", "");
	return lines.join("\n");
}
/** Parse the JSONL source, dropping a malformed line rather than failing the read. */
function parseEntries(text) {
	const entries = [];
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (typeof parsed.id === "string" && typeof parsed.text === "string") entries.push(parsed);
		} catch {}
	}
	return entries;
}
/**
* Build the queue over one directory.
* @param options Directory, TTL, and a clock seam for tests.
* @returns The queue.
*/
function createQueue(options) {
	const ttlDays = options.ttlDays ?? 7;
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	const jsonl = join(options.dir, "pending.jsonl");
	const markdown = join(options.dir, "pending.md");
	const archive = join(options.dir, "archive.jsonl");
	let chain = Promise.resolve();
	const serialize = (task) => {
		const next = chain.then(task, task);
		chain = next.then(() => void 0, () => void 0);
		return next;
	};
	const readAll = async () => {
		try {
			return parseEntries(await readFile(jsonl, "utf8"));
		} catch (error) {
			if (error.code === "ENOENT") return [];
			throw error;
		}
	};
	const writeAll = async (entries) => {
		const body = entries.map((entry) => JSON.stringify(entry)).join("\n");
		const temp = `${jsonl}.tmp-${randomUUID()}`;
		await writeFile(temp, body.length === 0 ? "" : `${body}\n`, "utf8");
		await rename(temp, jsonl);
	};
	const refreshView = async (entries) => {
		const text = renderMarkdown(entries);
		const temp = `${markdown}.tmp-${randomUUID()}`;
		await writeFile(temp, text, "utf8");
		await rename(temp, markdown);
		return text;
	};
	const isOverdue = (entry) => {
		const created = Date.parse(entry.created_at);
		if (Number.isNaN(created)) return false;
		return now().getTime() - created > ttlDays * 24 * 60 * 60 * 1e3;
	};
	return {
		paths: () => ({
			jsonl,
			markdown,
			archive
		}),
		async offer(input) {
			const text = input.text.trim();
			if (text.length === 0) return void 0;
			const hash = hashText(text);
			return serialize(async () => {
				await mkdir(options.dir, { recursive: true });
				const existing = await readAll();
				if (existing.some((entry) => entry.hash === hash)) return void 0;
				const entry = {
					id: randomUUID(),
					hash,
					text,
					metadata: input.metadata ?? {},
					confidence: input.confidence,
					created_at: now().toISOString(),
					status: "pending",
					...input.evidence === void 0 ? {} : { evidence: input.evidence },
					...input.sourceSession === void 0 ? {} : { source_session: input.sourceSession }
				};
				await appendFile(jsonl, `${JSON.stringify(entry)}\n`, "utf8");
				await refreshView([...existing, entry]);
				return entry;
			});
		},
		list: async () => readAll(),
		async expire() {
			return serialize(async () => {
				const entries = await readAll();
				const due = entries.filter((entry) => entry.status === "pending" && isOverdue(entry));
				if (due.length === 0) return 0;
				const stamp = now().toISOString();
				const updated = entries.map((entry) => due.some((row) => row.id === entry.id) ? {
					...entry,
					status: "expired",
					decided_at: stamp,
					decided_by: "ttl"
				} : entry);
				await mkdir(options.dir, { recursive: true });
				await appendFile(archive, `${due.map((entry) => JSON.stringify({
					...entry,
					status: "expired",
					decided_at: stamp
				})).join("\n")}\n`, "utf8");
				await writeAll(updated);
				await refreshView(updated);
				return due.length;
			});
		},
		async decide(id, status, decideOptions = {}) {
			return serialize(async () => {
				const entries = await readAll();
				const index = entries.findIndex((entry) => entry.id === id);
				const current = entries[index];
				if (current === void 0) return void 0;
				const updated = {
					...current,
					status,
					decided_at: now().toISOString(),
					...decideOptions.decidedBy === void 0 ? { decided_by: "human" } : { decided_by: decideOptions.decidedBy },
					...decideOptions.storedMemoryId === void 0 ? {} : { stored_memory_id: decideOptions.storedMemoryId },
					...decideOptions.supersedes === void 0 ? {} : { supersedes: decideOptions.supersedes }
				};
				const next = [...entries];
				next[index] = updated;
				await writeAll(next);
				await refreshView(next);
				return updated;
			});
		},
		async render() {
			const entries = await readAll();
			await mkdir(options.dir, { recursive: true });
			return refreshView(entries);
		}
	};
}
//#endregion
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
//#region src/decisions.ts
/** Resolve an id or an unambiguous id prefix, since reviewers quote short ids. */
function findEntry(entries, id) {
	return entries.find((entry) => entry.id === id || entry.id.startsWith(id));
}
/** One review line: what it says and how to address it. */
function renderEntry(entry) {
	const facts = [
		entry.metadata.category,
		entry.metadata.scope,
		entry.metadata.importance
	].filter((value) => value !== void 0);
	const suffix = facts.length === 0 ? "" : `（${facts.join(" · ")}）`;
	const evidence = entry.evidence === void 0 ? "" : `\n  证据：${entry.evidence}`;
	return `- [${entry.id.slice(0, 6)}] ${entry.text}${suffix} conf ${entry.confidence.toFixed(2)}${evidence}`;
}
/**
* The pending view both doors render.
* @param entries All entries from the queue.
* @returns The pending entries and their rendered text.
*/
function pendingView(entries) {
	const pending = entries.filter((entry) => entry.status === "pending");
	return {
		entries: pending,
		text: pending.length === 0 ? "候审队列为空。" : `待审 ${pending.length} 条：\n${pending.map(renderEntry).join("\n")}`
	};
}
/**
* Approve one candidate: dedupe, then write, then record.
* @param deps Queue, client factory, and the dedupe threshold.
* @param id Entry id or id prefix.
* @param decidedBy Optional note recorded as the decider.
* @returns The outcome and its narrative.
*/
async function approveEntry(deps, id, decidedBy) {
	const entry = findEntry(await deps.queue.list(), id);
	if (entry === void 0) return {
		ok: false,
		text: `没有找到候审条目 ${id}。`
	};
	const threshold = deps.dedupeThreshold ?? .8;
	const record = decidedBy === void 0 ? {} : { decidedBy };
	const client = await deps.client();
	const best = (await client.recall({
		query: entry.text,
		topK: 3
	}))[0];
	if (best !== void 0 && (best.score ?? 0) >= threshold) {
		const result = await client.supersede({
			oldId: best.id,
			text: entry.text,
			metadata: entry.metadata
		});
		const created = result.created[0];
		const updated = await deps.queue.decide(entry.id, "approved", {
			supersedes: result.supersededId,
			...created === void 0 ? {} : { storedMemoryId: created.id },
			...record
		});
		return {
			ok: true,
			text: `已批准并取代 ${result.supersededId.slice(0, 8)}：${entry.text}`,
			...updated === void 0 ? {} : { entry: updated }
		};
	}
	const stored = (await client.remember({
		text: entry.text,
		metadata: entry.metadata,
		infer: false
	}))[0];
	const updated = await deps.queue.decide(entry.id, "approved", {
		...stored === void 0 ? {} : { storedMemoryId: stored.id },
		...record
	});
	return {
		ok: true,
		text: stored === void 0 ? `已批准并写入：${entry.text}` : `已批准并写入 ${stored.id.slice(0, 8)}：${entry.text}`,
		...updated === void 0 ? {} : { entry: updated }
	};
}
/**
* Dismiss one candidate. Never touches mem0: a rejection is a queue fact.
* @param queue The queue.
* @param id Entry id or id prefix.
* @param decidedBy Optional note recorded as the decider.
* @returns The outcome and its narrative.
*/
async function dismissEntry(queue, id, decidedBy) {
	const entry = findEntry(await queue.list(), id);
	if (entry === void 0) return {
		ok: false,
		text: `没有找到候审条目 ${id}。`
	};
	const updated = await queue.decide(entry.id, "dismissed", decidedBy === void 0 ? {} : { decidedBy });
	return {
		ok: true,
		text: `已驳回：${entry.text}`,
		...updated === void 0 ? {} : { entry: updated }
	};
}
//#endregion
//#region src/route.ts
/** Route prefix the tab and the host both address. */
const PENDING_PREFIX = "/memory/pending";
/** A request-shaped view of the queue, or a decision applied to it. */
async function handlePendingRequest(deps, request) {
	if (request.method === "GET") {
		const view = pendingView(await deps.queue.list());
		return {
			status: 200,
			body: {
				ok: true,
				text: view.text,
				entries: view.entries
			}
		};
	}
	if (request.method !== "POST") return {
		status: 405,
		body: {
			ok: false,
			error: "method not allowed"
		}
	};
	const body = typeof request.body === "object" && request.body !== null ? request.body : {};
	const id = typeof body["id"] === "string" ? body["id"] : void 0;
	const note = typeof body["note"] === "string" ? body["note"] : void 0;
	if (id === void 0) return {
		status: 400,
		body: {
			ok: false,
			error: "id is required"
		}
	};
	if (!request.path.endsWith("/approve") && !request.path.endsWith("/dismiss")) return {
		status: 404,
		body: {
			ok: false,
			error: `未知路径 ${request.path}（GET 列表 / POST …/approve / POST …/dismiss）`
		}
	};
	const result = request.path.endsWith("/approve") ? await approveEntry(deps, id, note) : await dismissEntry(deps.queue, id, note);
	return {
		status: result.ok ? 200 : 404,
		body: {
			ok: result.ok,
			text: result.text,
			...result.entry === void 0 ? {} : { entry: result.entry }
		}
	};
}
/** Read a JSON body, tolerating an empty or malformed one (the caller reports 400). */
async function readJsonBody(request) {
	let raw = "";
	for await (const chunk of request) raw += String(chunk);
	if (raw.trim().length === 0) return void 0;
	try {
		return JSON.parse(raw);
	} catch {
		return;
	}
}
/**
* Publish the route when the host exposes a webServer.
* @param ctx Host context (only `get`, an optional `effect`, and a logger are used).
* @param deps Queue, client factory, and the dedupe threshold.
*/
function registerPendingRoute(ctx, deps) {
	const webServer = ctx.get?.("webServer");
	if (typeof webServer?.register !== "function") return;
	try {
		const dispose = webServer.register({
			kind: "prefix",
			path: PENDING_PREFIX,
			handler: async (request, response) => {
				const url = new URL(request.url ?? "/", "http://dsh.internal");
				const result = await handlePendingRequest(deps, {
					method: request.method ?? "GET",
					path: url.pathname,
					...request.method === "POST" ? { body: await readJsonBody(request) } : {}
				});
				response.statusCode = result.status;
				response.setHeader("Content-Type", "application/json");
				response.end(JSON.stringify(result.body));
			}
		});
		ctx.effect?.(() => dispose, "dsh-memory: pending review route");
	} catch (error) {
		ctx.logger?.warn?.(`dsh-memory: 候审路由注册失败: ${error instanceof Error ? error.message : String(error)}`);
	}
}
//#endregion
//#region src/review.ts
/**
* The review tool — the queue's non-UI door.
*
* Deliberately thin: the decision flow (dedupe → supersede or faithful write →
* record) lives in `decisions.ts`, because the sidebar route opens the same door
* and a second copy of that order would drift.
* @module dsh-memory/review
*/
/**
* Register `memory_review`.
* @param ctx Host context.
* @param deps Queue, client factory, and the dedupe threshold.
*/
function registerReviewTool(ctx, deps) {
	ctx.tools.register(defineTool({
		name: "memory_review",
		description: "长期记忆：查看候审队列并批准或驳回候选事实。批准时先判重——命中已有记忆则取代它，否则保真新增。侧边栏待审页不可用时的替代入口。",
		parameters: {
			action: {
				type: "string",
				required: true,
				description: "list | approve | dismiss"
			},
			id: {
				type: "string",
				description: "approve / dismiss 的条目 id（memory_review list 返回的完整 id 或其前几位）。"
			},
			note: {
				type: "string",
				description: "可选备注，作为 decided_by 记入条目。"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: { text: {
					type: "string",
					required: true
				} }
			},
			render: (_args, value) => [{
				type: "text",
				text: value.text
			}]
		},
		isConcurrencySafe: () => false,
		async execute(args) {
			if (args.action === "list") return { text: pendingView(await deps.queue.list()).text };
			if (args.action !== "approve" && args.action !== "dismiss") return { text: `未知 action：${args.action}（支持 list | approve | dismiss）。` };
			if (args.id === void 0) return { text: `${args.action} 需要 id；先用 memory_review list 查看。` };
			return { text: (args.action === "approve" ? await approveEntry(deps, args.id, args.note) : await dismissEntry(deps.queue, args.id, args.note)).text };
		}
	}));
}
//#endregion
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
*/
function registerSkill(ctx, source) {
	const skills = ctx.get?.("skills");
	if (typeof skills?.registerProvider !== "function") return;
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
	} catch (error) {
		ctx.logger?.warn?.(`dsh-memory: skill registration failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}
//#endregion
//#region src/tools.ts
/**
* Tool surface — the `memory_*` tools the model calls.
*
* Every tool resolves credentials per call (the client factory re-resolves), so
* a rotated key reaches the next call without a restart. Descriptions are
* model-facing: they say what the tool does to the shared memory, not how it is
* implemented.
* @module dsh-memory/tools
*/
/** Metadata assembled from the scalar tool parameters. */
function metadataFrom(args) {
	const metadata = {};
	if (args.category !== void 0) metadata.category = args.category;
	if (args.scope !== void 0) metadata.scope = args.scope;
	if (args.importance !== void 0) metadata.importance = args.importance;
	if (args.project !== void 0) metadata.project = args.project;
	if (args.source !== void 0) metadata.source = args.source;
	if (args.tags !== void 0) {
		const tags = args.tags.split(",").map((tag) => tag.trim()).filter((tag) => tag.length > 0);
		if (tags.length > 0) metadata.tags = tags;
	}
	return metadata;
}
/** One rendered line per memory, newest information first-class and id-addressable. */
function renderRows(rows) {
	if (rows.length === 0) return "没有匹配的记忆。";
	return rows.map((row) => {
		const meta = row.metadata;
		const facts = [
			meta.category,
			meta.scope,
			meta.importance
		].filter((value) => value !== void 0);
		const suffix = facts.length === 0 ? "" : `（${facts.join(" · ")}）`;
		const score = row.score === void 0 ? "" : ` score=${row.score.toFixed(3)}`;
		return `- [${row.id.slice(0, 8)}] ${row.memory}${suffix}${score}`;
	}).join("\n");
}
/** The shared shape of a rendered list of memories. */
const LIST_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		count: {
			type: "number",
			required: true,
			description: "Number of memories returned."
		},
		memories: {
			type: "array",
			required: true,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: {
						type: "string",
						required: true
					},
					memory: {
						type: "string",
						required: true
					},
					category: { type: "string" },
					scope: { type: "string" },
					importance: { type: "string" },
					status: { type: "string" },
					score: { type: "number" }
				}
			}
		},
		text: {
			type: "string",
			required: true,
			description: "The same list rendered for the model."
		}
	}
};
/** Project service rows into the list schema's item shape. */
function toListItems(rows) {
	return rows.map((row) => ({
		id: row.id,
		memory: row.memory,
		...row.metadata.category === void 0 ? {} : { category: row.metadata.category },
		...row.metadata.scope === void 0 ? {} : { scope: row.metadata.scope },
		...row.metadata.importance === void 0 ? {} : { importance: row.metadata.importance },
		...row.metadata.status === void 0 ? {} : { status: row.metadata.status },
		...row.score === void 0 ? {} : { score: row.score }
	}));
}
/**
* Register the memory tools.
* @param ctx Host context; registrations are effects scoped to it.
* @param deps Client factory.
*/
function registerMemoryTools(ctx, deps) {
	ctx.tools.register(defineTool({
		name: "memory_remember",
		description: "长期记忆：写入一条事实（默认保真写入，不做 LLM 改写）。用于记住用户明确表达、且跨会话仍然成立的偏好、约束、决策或工作方式。",
		parameters: {
			text: {
				type: "string",
				required: true,
				description: "要记住的事实，一句话，保留用户原话中的关键措辞。"
			},
			category: {
				type: "string",
				description: "fact | preference | project | person | relation | decision | constraint | goal | workflow"
			},
			scope: {
				type: "string",
				description: "user | project | agent | session；session 级信息不要写入长期记忆。"
			},
			importance: {
				type: "string",
				description: "permanent | long_term | temporary"
			},
			project: {
				type: "string",
				description: "scope=project 时的项目名。"
			},
			tags: {
				type: "string",
				description: "逗号分隔的标签。"
			},
			infer: {
				type: "boolean",
				description: "true 时交给服务端抽取改写（可能改写措辞）；默认 false 保真写入。"
			}
		},
		output: {
			schema: LIST_SCHEMA,
			render: (_args, value) => [{
				type: "text",
				text: `已写入 ${value.count} 条：\n${value.text}`
			}]
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			const rows = await (await deps.client()).remember({
				text: args.text,
				metadata: metadataFrom(args),
				infer: args.infer ?? false
			});
			return {
				count: rows.length,
				memories: toListItems(rows),
				text: renderRows(rows)
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "memory_recall",
		description: "长期记忆：按语义检索相关记忆。在回答依赖用户既有偏好、约定或历史决策时使用；不要求关键词匹配。",
		parameters: {
			query: {
				type: "string",
				required: true,
				description: "自然语言查询，例如“用户对输出的偏好”。"
			},
			top_k: {
				type: "number",
				description: "最多返回条数，默认 10。"
			},
			category: {
				type: "string",
				description: "只返回该分类。"
			},
			scope: {
				type: "string",
				description: "只返回该作用域：user | project | agent | session。"
			},
			include_historical: {
				type: "boolean",
				description: "是否包含已被取代（historical）的事实，默认 false。"
			}
		},
		output: {
			schema: LIST_SCHEMA,
			render: (_args, value) => [{
				type: "text",
				text: value.count === 0 ? "没有匹配的记忆。" : `匹配到 ${value.count} 条：\n${value.text}`
			}]
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			const rows = await (await deps.client()).recall({
				query: args.query,
				topK: args.top_k ?? 10,
				...args.category === void 0 ? {} : { category: args.category },
				...args.scope === void 0 ? {} : { scope: args.scope },
				...args.include_historical === void 0 ? {} : { includeHistorical: args.include_historical }
			});
			return {
				count: rows.length,
				memories: toListItems(rows),
				text: renderRows(rows)
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "memory_read",
		description: "长期记忆：按 id 读取一条记忆的完整内容与元数据。",
		parameters: { id: {
			type: "string",
			required: true,
			description: "记忆 id（memory_recall / memory_inventory 返回的完整 id）。"
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					found: {
						type: "boolean",
						required: true
					},
					id: { type: "string" },
					memory: { type: "string" },
					text: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.text
			}]
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			const row = await (await deps.client()).read(args.id);
			if (row === void 0) return {
				found: false,
				text: "没有找到该 id 的记忆。"
			};
			return {
				found: true,
				id: row.id,
				memory: row.memory,
				text: `${row.memory}\n元数据：${JSON.stringify(row.metadata)}`
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "memory_supersede",
		description: "长期记忆：用新事实取代一条旧记忆（旧条标记为 historical，新条带 supersedes 指针）。当新信息与已存记忆矛盾时使用——不要并存两条互相矛盾的事实。",
		parameters: {
			old_id: {
				type: "string",
				required: true,
				description: "被取代的旧记忆 id。"
			},
			text: {
				type: "string",
				required: true,
				description: "取代后的新事实。"
			},
			category: {
				type: "string",
				description: "新条目的分类；省略则沿用旧条的展示字段。"
			},
			scope: {
				type: "string",
				description: "新条目的作用域。"
			},
			importance: {
				type: "string",
				description: "新条目的重要度。"
			},
			project: {
				type: "string",
				description: "所属项目名。"
			},
			source: {
				type: "string",
				description: "来源标识，例如会话 id。"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					superseded_id: {
						type: "string",
						required: true
					},
					count: {
						type: "number",
						required: true
					},
					text: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: `已取代 ${value.superseded_id.slice(0, 8)}，新写入 ${value.count} 条：\n${value.text}`
			}]
		},
		isConcurrencySafe: () => false,
		async execute(args) {
			const result = await (await deps.client()).supersede({
				oldId: args.old_id,
				text: args.text,
				metadata: metadataFrom(args)
			});
			return {
				superseded_id: result.supersededId,
				count: result.created.length,
				text: renderRows(result.created)
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "memory_inventory",
		description: "长期记忆：盘点记忆库，按分类、作用域、状态或重要度过滤。用于审计、查重和回答“我记得哪些”。",
		parameters: {
			top_k: {
				type: "number",
				description: "最多返回条数，默认 50。"
			},
			category: {
				type: "string",
				description: "只返回该分类。"
			},
			status: {
				type: "string",
				description: "current | historical；默认不过滤。"
			},
			scope: {
				type: "string",
				description: "user | project | agent | session。"
			},
			importance: {
				type: "string",
				description: "permanent | long_term | temporary。"
			}
		},
		output: {
			schema: LIST_SCHEMA,
			render: (_args, value) => [{
				type: "text",
				text: value.count === 0 ? "记忆库中没有符合条件的条目。" : `共 ${value.count} 条：\n${value.text}`
			}]
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			const rows = await (await deps.client()).inventory({
				topK: args.top_k ?? 50,
				...args.category === void 0 ? {} : { category: args.category },
				...args.status === void 0 ? {} : { status: args.status },
				...args.scope === void 0 ? {} : { scope: args.scope },
				...args.importance === void 0 ? {} : { importance: args.importance }
			});
			return {
				count: rows.length,
				memories: toListItems(rows),
				text: renderRows(rows)
			};
		}
	}));
	ctx.tools.register(defineTool({
		name: "memory_brief",
		description: "长期记忆：生成一段按分类分组的用户画像摘要。在需要“这个用户是谁、长期偏好什么”时使用，比逐条检索更省上下文。",
		parameters: { max_chars: {
			type: "number",
			description: "摘要的字符预算，默认 1200。"
		} },
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					count: {
						type: "number",
						required: true
					},
					brief: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.brief.length === 0 ? "记忆库为空。" : value.brief
			}]
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			const rows = await (await deps.client()).inventory({ topK: 200 });
			return {
				count: rows.length,
				brief: buildBrief(rows, { maxChars: args.max_chars ?? 1200 })
			};
		}
	}));
}
//#endregion
//#region src/index.ts
/**
* dsh-memory — the host entry that wires the layers together.
*
* Three lifecycle points, each with a job that must not block or fail the turn:
* - `agent/created` injects a brief (who this user is, within a budget).
* - `agent/pre-step` injects recall for this prompt and remembers the turn's
*   text; it delegates with `next()` immediately rather than waiting on the
*   network, because a slow memory service must not delay a step.
* - `agent/turn-stopping` turns the turn's text into review candidates. It never
*   writes to mem0: approval is a separate, human act.
*
* Every mem0 call is fail-open. A memory service that is down degrades this
* plugin to a no-op; it never fails a session.
* @module dsh-memory
*/
const name = "memory";
/** The tool runtime is the one capability this plugin cannot work without. */
const inject = ["tools"];
const CONTEXT_SOURCE = { kind: "dsh-memory" };
/** Character budgets, fixed by the design. */
const BRIEF_BUDGET = 1200;
const RECALL_BUDGET = 600;
const RECALL_TOP_K = 3;
const BRIEF_TOP_K = 200;
const Config = z.object({
	baseUrl: z.string().default(""),
	userId: z.string().default(""),
	pendingDir: z.string().default(""),
	recall: z.boolean().default(true),
	capture: z.boolean().default(true),
	pendingTtlDays: z.number().default(7),
	captureThreshold: z.number().default(.6),
	maxPerTurn: z.number().default(5)
});
/** `$DSH_HOME` when set, else `~/.dsh` — the same anchor the harness home uses. */
function resolveDshHome(env = process.env) {
	const fromEnv = env["DSH_HOME"];
	return typeof fromEnv === "string" && fromEnv.length > 0 ? fromEnv : join(homedir(), ".dsh");
}
/** Text blocks of one message, so hooks never see a content union. */
function textOfBlocks(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text);
}
function errorText(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* Mount the memory plugin.
* @param ctx Host context; registrations are effects scoped to it.
* @param config Resolved plugin configuration.
*/
function apply(ctx, config) {
	const queue = createQueue({
		dir: config.pendingDir?.trim() || join(resolveDshHome(), "memory-pending"),
		ttlDays: config.pendingTtlDays ?? 7
	});
	const client = async () => createMem0Client(await resolveMem0Credentials(ctx, config));
	registerMemoryTools(ctx, { client });
	registerReviewTool(ctx, {
		queue,
		client
	});
	registerSkill(ctx, "dsh-memory");
	registerPendingRoute(ctx, {
		queue,
		client
	});
	const turnTexts = /* @__PURE__ */ new Map();
	const injectContext = (agent, text) => {
		agent.inject(createUserMessage({
			content: [{
				type: "text",
				text
			}],
			source: CONTEXT_SOURCE
		}));
	};
	if (config.recall !== false) ctx.on("agent/created", async ({ agent, signal }) => {
		try {
			const rows = await (await client()).inventory({ topK: BRIEF_TOP_K });
			if (signal?.aborted === true) return;
			const text = renderBriefInjection(buildBrief(rows, { maxChars: BRIEF_BUDGET }));
			if (text !== void 0) injectContext(agent, text);
		} catch (error) {
			ctx.logger.warn(`dsh-memory: 启动召回失败（已忽略）: ${errorText(error)}`);
		}
	});
	ctx.on("agent/pre-step", async ({ agent, messages, signal }, next) => {
		const texts = messages.flatMap((message) => textOfBlocks(message.content));
		turnTexts.set(String(agent.session.header.id), texts);
		if (config.recall !== false) {
			const query = texts.join("\n").trim().slice(0, 500);
			if (query.length > 0) (async () => {
				try {
					const rows = await (await client()).recall({
						query,
						topK: RECALL_TOP_K
					});
					if (signal?.aborted === true) return;
					const text = renderRecallInjection(rows, { searchChars: RECALL_BUDGET });
					if (text !== void 0) injectContext(agent, text);
				} catch (error) {
					ctx.logger.warn(`dsh-memory: 检索注入失败（已忽略）: ${errorText(error)}`);
				}
			})();
		}
		return next();
	});
	ctx.on("agent/turn-stopping", async ({ agent }) => {
		if (config.capture === false) return;
		const key = String(agent.session.header.id);
		const texts = turnTexts.get(key) ?? [];
		turnTexts.delete(key);
		if (texts.length === 0) return;
		const candidates = extractCandidates(texts, {
			threshold: config.captureThreshold ?? .6,
			maxPerTurn: config.maxPerTurn ?? 5
		});
		if (candidates.length === 0) return;
		try {
			await queue.expire();
			for (const candidate of candidates) await queue.offer({
				text: candidate.text,
				confidence: candidate.confidence,
				sourceSession: key
			});
		} catch (error) {
			ctx.logger.warn(`dsh-memory: 候审入队失败（已忽略）: ${errorText(error)}`);
		}
	});
}
//#endregion
export { Config, apply, inject, name, resolveDshHome };
