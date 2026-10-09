import { S as createQueue, a as queueEventTrace, f as sharedTracer, g as activeBootReporter, i as makeClientFactory, s as resolvePendingDir } from "./runtime-Dj3ts4HE.js";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
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
	if (entry === void 0) {
		deps.tracer?.log("info", "decision", "approve.missing", { id: id.slice(0, 8) });
		return {
			ok: false,
			text: `没有找到候审条目 ${id}。`
		};
	}
	deps.tracer?.log("info", "decision", "approve.start", {
		id: entry.id.slice(0, 8),
		textChars: entry.text.length
	});
	try {
		const threshold = deps.dedupeThreshold ?? .8;
		const record = decidedBy === void 0 ? {} : { decidedBy };
		const client = await deps.client();
		const hits = await client.recall({
			query: entry.text,
			topK: 3
		});
		const best = hits[0];
		deps.tracer?.log("debug", "decision", "approve.dedupe", {
			hits: hits.length,
			best: best?.id.slice(0, 8),
			score: best?.score
		});
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
			deps.tracer?.log("info", "decision", "approve.done", {
				outcome: "superseded",
				superseded: result.supersededId.slice(0, 8),
				stored: created?.id.slice(0, 8)
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
		deps.tracer?.log("info", "decision", "approve.done", {
			outcome: "created",
			stored: stored?.id.slice(0, 8)
		});
		return {
			ok: true,
			text: stored === void 0 ? `已批准并写入：${entry.text}` : `已批准并写入 ${stored.id.slice(0, 8)}：${entry.text}`,
			...updated === void 0 ? {} : { entry: updated }
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		deps.tracer?.log("warn", "decision", "approve.error", {
			id: entry.id.slice(0, 8),
			error: message.slice(0, 200)
		});
		throw error;
	}
}
/**
* Dismiss one candidate. Never touches mem0: a rejection is a queue fact.
* @param queue The queue.
* @param id Entry id or id prefix.
* @param decidedBy Optional note recorded as the decider.
* @returns The outcome and its narrative.
*/
async function dismissEntry(queue, id, decidedBy, tracer) {
	const entry = findEntry(await queue.list(), id);
	if (entry === void 0) {
		tracer?.log("info", "decision", "dismiss.missing", { id: id.slice(0, 8) });
		return {
			ok: false,
			text: `没有找到候审条目 ${id}。`
		};
	}
	const updated = await queue.decide(entry.id, "dismissed", decidedBy === void 0 ? {} : { decidedBy });
	tracer?.log("info", "decision", "dismiss.done", { id: entry.id.slice(0, 8) });
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
	const result = request.path.endsWith("/approve") ? await approveEntry(deps, id, note) : await dismissEntry(deps.queue, id, note, deps.tracer);
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
* @returns What happened, for the boot self-check report.
*/
function registerPendingRoute(ctx, deps) {
	const webServer = ctx.get?.("webServer");
	if (typeof webServer?.register !== "function") return {
		state: "skip",
		detail: "宿主未提供 webServer，侧边栏待审页不可用（工具照常）"
	};
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
		return {
			state: "ok",
			detail: `前缀 ${PENDING_PREFIX} 已注册`
		};
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		ctx.logger?.warn?.(`dsh-memory: 候审路由注册失败: ${reason}`);
		return {
			state: "fail",
			detail: `注册失败：${reason}`
		};
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
			return { text: (args.action === "approve" ? await approveEntry(deps, args.id, args.note) : await dismissEntry(deps.queue, args.id, args.note, deps.tracer)).text };
		}
	}));
}
//#endregion
//#region src/review-plugin.ts
const name = "memory-review";
/** The tool runtime is the one capability this component cannot work without. */
const inject = ["tools"];
const Config = z.object({
	baseUrl: z.string().default(""),
	userId: z.string().default(""),
	pendingDir: z.string().default(""),
	dedupeThreshold: z.number().default(.8)
});
/**
* Mount the review component.
* @param ctx Host context; registrations are effects scoped to it.
* @param config Resolved component configuration.
*/
function apply(ctx, config) {
	const pendingDir = resolvePendingDir(config);
	const deps = {
		queue: createQueue({
			dir: pendingDir,
			onEvent: queueEventTrace
		}),
		client: makeClientFactory(ctx, config),
		...config.dedupeThreshold === void 0 ? {} : { dedupeThreshold: config.dedupeThreshold },
		tracer: sharedTracer
	};
	registerReviewTool(ctx, deps);
	const routeResult = registerPendingRoute(ctx, deps);
	const boot = activeBootReporter();
	boot?.report("review", "ok", "memory_review 工具已注册");
	boot?.report("route", routeResult.state, routeResult.detail);
}
//#endregion
export { Config, apply, inject, name };
