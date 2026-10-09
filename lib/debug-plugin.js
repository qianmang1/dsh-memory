import { C as isMem0Error, _ as bootReportLevel, b as clearBootReporter, d as envDebugEnabled, f as sharedTracer, h as activateBootReporter, l as resolveMem0Credentials, n as hostLogger, o as resolveDshHome, p as shutdownTracing, s as resolvePendingDir, t as errorText, u as configureTracing, v as checkQueueDir, x as pingMem0, y as checkTraceFile } from "./runtime-Dj3ts4HE.js";
import { t as loadSkillBody } from "./skill-tyjMBpf2.js";
import z from "@deepseek-ai/schemastery";
import { join } from "node:path";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/debug-plugin.ts
/**
* Debug component — tracing, the `memory_debug` tool, and the boot self-check.
*
* One of five independently toggleable components, and the one the user asked
* to control by hand: enabling it opens the shared trace gate (ring + optional
* NDJSON sink) and registers `memory_debug`; disabling it stops every trace
* output from every component at once, because they all write through the
* gated `sharedTracer`. Failures and warnings from the boot report surface at
* warn/error even while the debug level itself is quiet.
* @module dsh-memory/debug
*/
const name = "memory-debug";
/** The tool runtime is the one capability this component cannot work without. */
const inject = ["tools"];
const Config = z.object({
	debugLog: z.boolean().default(false),
	pendingDir: z.string().default("")
});
const TRACE_LEVELS = [
	"debug",
	"info",
	"warn",
	"error"
];
/**
* Mount the debug component.
* @param ctx Host context; registrations are effects scoped to it.
* @param config Resolved component configuration.
*/
function apply(ctx, config) {
	const debugOn = config.debugLog === true || envDebugEnabled();
	const traceFile = join(resolveDshHome(), "logs", "dsh-memory-trace.ndjson");
	configureTracing(debugOn ? { file: traceFile } : {});
	const logger = hostLogger(ctx);
	const reporter = activateBootReporter({
		verbose: debugOn,
		emit: (level, message) => logger?.[level]?.(message),
		trace: (state, module, detail) => sharedTracer.log(bootReportLevel(state), "boot", module, {
			state,
			detail
		})
	});
	reporter.report("tracer", debugOn ? "ok" : "skip", debugOn ? `落盘就绪: ${traceFile}` : "仅内存环形缓冲（设 debugLog: true 或环境变量 DSH_MEMORY_LOG=1 启用落盘）");
	ctx.tools.register(defineTool({
		name: "memory_debug",
		description: "长期记忆诊断：查看本插件最近的运行事件（钩子触发、mem0 请求、候审队列变化、工具调用耗时）。只读，用于排查“记忆为什么没被记住/没被召回”。",
		parameters: {
			limit: {
				type: "number",
				description: "最多返回条数，默认 50，上限 200。"
			},
			op: {
				type: "string",
				description: "只看某个来源：hook | mem0 | queue | tool | decision | boot。"
			},
			level: {
				type: "string",
				description: "只看某个级别：debug | info | warn | error。"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					count: {
						type: "number",
						required: true
					},
					file: {
						type: "string",
						required: true,
						description: "NDJSON 落盘路径；未启用时说明启用方法。"
					},
					text: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.count === 0 ? "最近没有记录事件。" : `最近 ${value.count} 条事件（落盘：${value.file}）：\n${value.text}`
			}]
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			const level = args.level !== void 0 && TRACE_LEVELS.includes(args.level) ? args.level : void 0;
			const events = sharedTracer.recent({
				limit: Math.min(args.limit ?? 50, 200),
				...args.op === void 0 ? {} : { op: args.op },
				...level === void 0 ? {} : { level }
			});
			const text = events.map((entry) => `${entry.ts} ${entry.level.toUpperCase()} ${entry.op}/${entry.event}${entry.detail === void 0 ? "" : ` ${JSON.stringify(entry.detail)}`}`).join("\n");
			return {
				count: events.length,
				file: sharedTracer.file() ?? "未启用（配置 debugLog: true 或设环境变量 DSH_MEMORY_LOG=1）",
				text: text.length === 0 ? "（环形缓冲为空）" : text
			};
		}
	}));
	reporter.report("debug-tool", "ok", "memory_debug 已注册");
	ctx.effect(() => () => {
		clearBootReporter();
		shutdownTracing();
	}, "dsh-memory: debug tracing gate");
	(async () => {
		const skillBody = await loadSkillBody();
		reporter.report("skill-body", skillBody === void 0 ? "warn" : "ok", skillBody === void 0 ? "技能正文缺失（打包不完整），技能列表将为空" : `正文已就绪（${skillBody.length} 字符）`);
		if (debugOn) {
			const traceCheck = await checkTraceFile(traceFile);
			reporter.report(traceCheck.module, traceCheck.state, traceCheck.detail);
		}
		try {
			reporter.report(await checkQueueDir(resolvePendingDir(config), join(resolvePendingDir(config), "pending.jsonl")));
		} catch (error) {
			reporter.report("queue", "fail", `队列检查异常：${errorText(error).slice(0, 200)}`);
		}
		let creds;
		try {
			creds = await resolveMem0Credentials(ctx, {});
			reporter.report("credentials", "ok", `endpoint=${creds.baseUrl} user=${creds.userId}（key 不记录）`);
		} catch (error) {
			reporter.report("credentials", "fail", errorText(error).replace(/^dsh-memory: /, ""));
		}
		if (creds !== void 0) try {
			const ms = await pingMem0(creds);
			reporter.report("mem0", ms > 2e3 ? "warn" : "ok", `连通 ${ms}ms（GET /memories topK=1）`);
		} catch (error) {
			if (isMem0Error(error)) {
				const state = error.kind === "auth" || error.kind === "network" ? "fail" : "warn";
				reporter.report("mem0", state, `${error.kind === "auth" ? "鉴权失败，检查 MEM0_API_KEY" : `服务异常（${error.kind}）`}：${errorText(error).replace(/^dsh-memory: /, "").slice(0, 200)}`);
			} else reporter.report("mem0", "fail", `连通性检查异常：${errorText(error).slice(0, 200)}`);
		}
		else reporter.report("mem0", "skip", "凭据未解析，跳过连通性检查");
		await new Promise((resolve) => {
			setTimeout(resolve, 25);
		});
		reporter.finish();
	})();
}
//#endregion
export { Config, apply, inject, name };
