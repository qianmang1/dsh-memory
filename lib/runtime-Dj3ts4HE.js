import { appendFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { credentialRef, isCredentialRefName } from "@deepseek-ai/dsh-credentials";
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
/** Type guard so callers can branch on the failure class without try/catch plumbing. */
function isMem0Error(error) {
	return error instanceof Mem0Error;
}
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
	const emit = options.onEvent;
	const request = async (method, path, body) => {
		const url = `${options.baseUrl}${path}`;
		const started = Date.now();
		const reqChars = body === void 0 ? 0 : JSON.stringify(body).length;
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
			const reason = error instanceof Error ? error.message : String(error);
			emit?.("http_error", {
				method,
				path,
				ms: Date.now() - started,
				kind: "network",
				error: reason.slice(0, 200)
			});
			throw new Mem0Error(`dsh-memory: mem0 请求失败（网络）: ${method} ${path} — ${reason}`, "network");
		}
		const text = await response.text();
		if (!response.ok) {
			const detail = text.slice(0, 500);
			const kind = response.status === 401 || response.status === 403 ? "auth" : response.status >= 500 ? "server" : "client";
			emit?.("http_error", {
				method,
				path,
				ms: Date.now() - started,
				status: response.status,
				kind,
				error: detail.slice(0, 200)
			});
			throw new Mem0Error(`dsh-memory: mem0 ${method} ${path} -> HTTP ${response.status}: ${detail}`, kind, response.status);
		}
		if (text.trim().length === 0) {
			emit?.("http", {
				method,
				path,
				ms: Date.now() - started,
				status: response.status,
				reqChars,
				resChars: 0
			});
			return {};
		}
		try {
			const parsed = JSON.parse(text);
			emit?.("http", {
				method,
				path,
				ms: Date.now() - started,
				status: response.status,
				reqChars,
				resChars: text.length
			});
			return parsed;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			emit?.("http_error", {
				method,
				path,
				ms: Date.now() - started,
				kind: "server",
				error: reason.slice(0, 200)
			});
			throw new Mem0Error(`dsh-memory: mem0 返回了非 JSON 响应: ${method} ${path} — ${reason}`, "server");
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
*   concurrency-safe across processes by itself, so writes are serialized per
*   directory across every queue instance in-process, and the state machine is
*   idempotent: a lost race costs one transition, not a corrupted queue.
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
* @param options Directory, TTL, a clock seam for tests, and an event seam for tracing.
* @returns The queue.
*/
function createQueue(options) {
	const ttlDays = options.ttlDays ?? 7;
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	const emit = options.onEvent;
	const jsonl = join(options.dir, "pending.jsonl");
	const markdown = join(options.dir, "pending.md");
	const archive = join(options.dir, "archive.jsonl");
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
			if (text.length === 0) {
				emit?.("offer_skip", { reason: "empty" });
				return;
			}
			const hash = hashText(text);
			return withDirLock(options.dir, async () => {
				await mkdir(options.dir, { recursive: true });
				const existing = await readAll();
				if (existing.some((entry) => entry.hash === hash)) {
					emit?.("offer_duplicate", {
						confidence: input.confidence,
						textChars: text.length
					});
					return;
				}
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
				emit?.("offer", {
					id: entry.id.slice(0, 8),
					confidence: entry.confidence,
					textChars: text.length
				});
				return entry;
			});
		},
		list: async () => readAll(),
		async expire() {
			return withDirLock(options.dir, async () => {
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
				emit?.("expire", { count: due.length });
				return due.length;
			});
		},
		async decide(id, status, decideOptions = {}) {
			return withDirLock(options.dir, async () => {
				const entries = await readAll();
				const index = entries.findIndex((entry) => entry.id === id);
				const current = entries[index];
				if (current === void 0) {
					emit?.("decide_missing", {
						id: id.slice(0, 8),
						to: status
					});
					return;
				}
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
				emit?.("decide", {
					id: updated.id.slice(0, 8),
					from: current.status,
					to: status,
					stored: updated.stored_memory_id?.slice(0, 8)
				});
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
/**
* Cross-instance serialization, keyed by directory. Since the component split,
* the capture plugin and the review plugin each build their own queue over the
* same directory, so the lock lives at module level: concurrent writes from
* any instance take their turn before they read the snapshot.
*/
const dirChains = /* @__PURE__ */ new Map();
function withDirLock(dir, task) {
	const key = process.platform === "win32" ? dir.toLowerCase() : dir;
	const next = (dirChains.get(key) ?? Promise.resolve()).then(task, task);
	dirChains.set(key, next.then(() => void 0, () => void 0));
	return next;
}
//#endregion
//#region src/boot.ts
/**
* Boot self-check — one status line per functional module at plugin mount.
*
* The requirement: in debug mode every module reports its init result and
* current state; a module that failed to start must name itself and the
* reason; anomalies surface at warn. Format is one unified line per module
* (`dsh-memory [boot] <module>: <STATE> — <detail>`) so a boot log can be
* scanned or grepped.
*
* Levels: ok/skip speak at debug, warn at warn, fail at error — so a broken
* module is visible even without debug mode, while a healthy boot stays
* quiet unless asked. Every line also lands in the trace ring, so
* `memory_debug` can replay a boot after the fact.
* @module dsh-memory/boot
*/
const STATE_LABEL = {
	ok: "OK",
	warn: "WARN",
	fail: "FAIL",
	skip: "SKIP"
};
const STATE_LEVEL = {
	ok: "debug",
	warn: "warn",
	fail: "error",
	skip: "debug"
};
/** The log level a boot state speaks at; shared with the trace ring. */
function bootReportLevel(state) {
	return STATE_LEVEL[state];
}
/** Build the boot reporter. `finish()` may be called once; later calls are no-ops. */
function createBootReporter(options) {
	const lines = [];
	let finished = false;
	const report = (module, state, detail) => {
		if (finished) return;
		const line = typeof module === "string" ? {
			module,
			state,
			detail
		} : module;
		lines.push(line);
		options.trace(line.state, line.module, line.detail);
		if (options.verbose || line.state === "warn" || line.state === "fail") options.emit(STATE_LEVEL[line.state], `dsh-memory [boot] ${line.module}: ${STATE_LABEL[line.state]} — ${line.detail}`);
	};
	return {
		report,
		finish() {
			if (finished || lines.length === 0) return;
			finished = true;
			const count = (state) => lines.filter((line) => line.state === state).length;
			const ok = count("ok");
			const warn = count("warn");
			const fail = count("fail");
			const skip = count("skip");
			const summary = `dsh-memory [boot] 自检完成：${lines.length} 模块（ok=${ok} warn=${warn} fail=${fail} skip=${skip}）`;
			const state = fail > 0 ? "fail" : warn > 0 ? "warn" : "ok";
			options.trace(state, "summary", `ok=${ok} warn=${warn} fail=${fail} skip=${skip}`);
			if (options.verbose || fail > 0 || warn > 0) options.emit(STATE_LEVEL[state], summary);
		},
		lines: () => lines
	};
}
/** Queue boot check: pending count, and malformed lines that parsing had to drop. */
async function checkQueueDir(dir, jsonlPath) {
	let raw;
	try {
		raw = await readFile(jsonlPath, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return {
			module: "queue",
			state: "ok",
			detail: `队列为空（${dir}）`
		};
		return {
			module: "queue",
			state: "fail",
			detail: `队列文件不可读：${error instanceof Error ? error.message : String(error)}`
		};
	}
	const physical = raw.split("\n").filter((line) => line.trim().length > 0).length;
	const entries = parseEntries(raw);
	const malformed = physical - entries.length;
	const pending = entries.filter((entry) => entry.status === "pending").length;
	if (malformed > 0) return {
		module: "queue",
		state: "warn",
		detail: `${pending} 待审 / ${entries.length} 有效；${malformed} 行损坏被忽略（中断写入残留）`
	};
	if (pending > 50) return {
		module: "queue",
		state: "warn",
		detail: `待审积压 ${pending} 条（${dir}）——尽快审阅`
	};
	return {
		module: "queue",
		state: "ok",
		detail: `${pending} 待审 / ${entries.length} 总数（${dir}）`
	};
}
/** Tracer file-sink boot check: the directory must exist and be writable. */
async function checkTraceFile(file) {
	try {
		await stat(file);
		return {
			module: "tracer",
			state: "ok",
			detail: `落盘文件已存在（追加模式）: ${file}`
		};
	} catch (error) {
		if (error.code !== "ENOENT") return {
			module: "tracer",
			state: "warn",
			detail: `落盘文件不可访问：${error instanceof Error ? error.message : String(error)}`
		};
		return {
			module: "tracer",
			state: "ok",
			detail: `落盘就绪（首次写入创建）: ${file}`
		};
	}
}
/** mem0 reachability: one cheap authenticated GET, measured. */
async function pingMem0(creds, options = {}) {
	const started = Date.now();
	await createMem0Client({
		baseUrl: creds.baseUrl,
		apiKey: creds.apiKey,
		userId: creds.userId,
		...options.timeoutMs === void 0 ? {} : { timeoutMs: options.timeoutMs },
		...options.fetchImpl === void 0 ? {} : { fetchImpl: options.fetchImpl }
	}).inventory({ topK: 1 });
	return Date.now() - started;
}
let active;
/** Install a fresh reporter (the debug component mounts); later ones replace it. */
function activateBootReporter(options) {
	active = createBootReporter(options);
	return active;
}
/** The reporter sibling components report into, or `undefined` when debug is off. */
function activeBootReporter() {
	return active;
}
/** Drop the slot; called when the debug component is disposed. */
function clearBootReporter() {
	active = void 0;
}
//#endregion
//#region src/debug.ts
/**
* Debug trace — the observability layer for agent-driven testing.
*
* The pain this exists for: hooks, HTTP calls, and queue transitions used to be
* silent, so testing through the agent meant guessing. Every interesting event
* now lands in an in-memory ring (always on, bounded, cheap) that the
* `memory_debug` tool can read, and — when explicitly enabled — in an NDJSON
* file under `$DSH_HOME/logs/` for cross-session post-mortems.
*
* Redaction is defence in depth, not decoration: log points are designed to
* carry scalars (ids, counts, statuses, timings) and never bodies, but a
* sanitizer still walks every detail so a sensitive-looking key or an
* over-long string cannot reach the sink.
* @module dsh-memory/debug
*/
const RING_DEFAULT = 300;
const STRING_LIMIT = 240;
const SENSITIVE_KEY = /pass(word)?|secret|token|api[-_]?key|authorization|cookie|credential/i;
/** Walk a detail object: scrub sensitive keys, bound strings and breadth. */
function sanitize(value, depth = 0) {
	if (depth > 4) return "[depth]";
	if (typeof value === "string") return value.length > STRING_LIMIT ? `${value.slice(0, STRING_LIMIT)}…(+${value.length - STRING_LIMIT})` : value;
	if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
	if (value === void 0) return void 0;
	if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
	if (typeof value === "object") {
		const out = {};
		for (const [key, item] of Object.entries(value)) out[key] = SENSITIVE_KEY.test(key) ? "[REDACTED]" : sanitize(item, depth + 1);
		return out;
	}
	return String(value);
}
/**
* Build the tracer. The ring is always on; the file sink is opt-in and fails
* silently — a broken debug sink must never break the plugin.
*/
function createTracer(options = {}) {
	const capacity = options.capacity ?? RING_DEFAULT;
	const ring = [];
	let sinkChain = Promise.resolve();
	if (options.file !== void 0) sinkChain = mkdir(dirname(options.file), { recursive: true }).then(() => void 0, () => void 0);
	return {
		log(level, op, event, detail) {
			const traced = {
				ts: (/* @__PURE__ */ new Date()).toISOString(),
				level,
				op,
				event,
				...detail === void 0 ? {} : { detail: sanitize(detail) }
			};
			ring.push(traced);
			if (ring.length > capacity) ring.splice(0, ring.length - capacity);
			if (options.file !== void 0) {
				const file = options.file;
				sinkChain = sinkChain.then(() => appendFile(file, `${JSON.stringify(traced)}\n`, "utf8")).catch(() => void 0);
			}
		},
		recent(query = {}) {
			const limit = Math.min(Math.max(query.limit ?? 50, 1), 500);
			return ring.filter((entry) => (query.level === void 0 || entry.level === query.level) && (query.op === void 0 || entry.op === query.op)).slice(-limit);
		},
		file: () => options.file
	};
}
/**
* Run one operation with start-to-end tracing, rethrowing unchanged.
* Success detail comes from the value; failures carry the error message.
*/
async function withTrace(tracer, op, event, run, detail) {
	const started = Date.now();
	if (tracer === void 0) return run();
	try {
		const value = await run();
		tracer.log("debug", op, event, {
			ms: Date.now() - started,
			...detail?.(value)
		});
		return value;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		tracer.log("warn", op, event, {
			ms: Date.now() - started,
			error: message.slice(0, STRING_LIMIT)
		});
		throw error;
	}
}
/** Whether `DSH_MEMORY_LOG` asks for the file sink without a config edit. */
function envDebugEnabled(env = process.env) {
	return /^(1|true|on|debug)$/i.test(env["DSH_MEMORY_LOG"] ?? "");
}
let shared = createTracer({ capacity: RING_DEFAULT });
let gate = false;
/**
* (Re)arm the shared tracer. Called by the debug component on mount; toggling
* rebuilds the tracer, so the ring starts clean for this enable cycle.
*/
function configureTracing(options = {}) {
	shared = createTracer(options);
	gate = true;
}
/** Silence every trace output; called when the debug component is disposed. */
function shutdownTracing() {
	gate = false;
}
/** The Tracer every component shares: a no-op sink while the gate is shut. */
const sharedTracer = {
	log(level, op, event, detail) {
		if (gate) shared.log(level, op, event, detail);
	},
	recent(query = {}) {
		return gate ? shared.recent(query) : [];
	},
	file() {
		return gate ? shared.file() : void 0;
	}
};
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
//#region src/runtime.ts
/**
* Component runtime seams — what the split plugins share.
*
* The bundle ships five independently toggleable cordis entries (core tools,
* recall injection, capture, review, debug). They run in one host process but
* mount as separate plugins, so anything more than one component needs — the
* message source, the client factory, the pending directory — lives here as a
* pure helper instead of a closure inside one `apply`.
* @module dsh-memory/runtime
*/
/** Provenance marker on every message this bundle injects. */
const CONTEXT_SOURCE = { kind: "dsh-memory" };
/** `$DSH_HOME` when set, else `~/.dsh` — the same anchor the harness home uses. */
function resolveDshHome(env = process.env) {
	const fromEnv = env["DSH_HOME"];
	return typeof fromEnv === "string" && fromEnv.length > 0 ? fromEnv : join(homedir(), ".dsh");
}
/** The pending-queue directory: an explicit override, else `$DSH_HOME/memory-pending`. */
function resolvePendingDir(config) {
	return config.pendingDir?.trim() || join(resolveDshHome(), "memory-pending");
}
/** Text blocks of one message, so hooks never see a content union. */
function textOfBlocks(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text);
}
function errorText(error) {
	return error instanceof Error ? error.message : String(error);
}
/** Read the host logger off a context, tolerating its absence in tests. */
function hostLogger(ctx) {
	return ctx.logger;
}
/** Hand one injected context message to an agent. */
function injectContext(agent, text) {
	agent.inject(createUserMessage({
		content: [{
			type: "text",
			text
		}],
		source: CONTEXT_SOURCE
	}));
}
/**
* Build the client factory one component uses. Credentials resolve per call,
* so a rotated key reaches the next operation; failures trace through the
* shared (gated) ring like every other event.
*/
function makeClientFactory(ctx, config) {
	return async () => createMem0Client({
		...await resolveMem0Credentials(ctx, config),
		onEvent: (event, detail) => sharedTracer.log(event.endsWith("_error") ? "warn" : "debug", "mem0", event, detail)
	});
}
/** The queue event seam every component's queue instance shares. */
function queueEventTrace(event, detail) {
	sharedTracer.log(event.startsWith("decide") ? "info" : "debug", "queue", event, detail);
}
//#endregion
export { isMem0Error as C, createQueue as S, bootReportLevel as _, queueEventTrace as a, clearBootReporter as b, textOfBlocks as c, envDebugEnabled as d, sharedTracer as f, activeBootReporter as g, activateBootReporter as h, makeClientFactory as i, resolveMem0Credentials as l, withTrace as m, hostLogger as n, resolveDshHome as o, shutdownTracing as p, injectContext as r, resolvePendingDir as s, errorText as t, configureTracing as u, checkQueueDir as v, pingMem0 as x, checkTraceFile as y };
