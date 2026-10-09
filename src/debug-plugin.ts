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

import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { activateBootReporter, bootReportLevel, checkQueueDir, checkTraceFile, clearBootReporter, pingMem0 } from './boot.ts'
import { configureTracing, envDebugEnabled, sharedTracer, shutdownTracing, type TraceLevel } from './debug.ts'
import { resolveMem0Credentials } from './credentials.ts'
import { isMem0Error } from './mem0.ts'
import { loadSkillBody } from './skill.ts'
import { errorText, hostLogger, resolveDshHome, resolvePendingDir } from './runtime.ts'

export const name = 'memory-debug'

/** The tool runtime is the one capability this component cannot work without. */
export const inject = ['tools']

export interface Config {
  /** Write runtime events to `$DSH_HOME/logs/dsh-memory-trace.ndjson`; the env var `DSH_MEMORY_LOG=1` enables it too. */
  debugLog?: boolean
  /** Pending-queue directory to health-check; empty means `$DSH_HOME/memory-pending` (keep in step with capture/review). */
  pendingDir?: string
}

export const Config: z<Config> = z.object({
  debugLog: z.boolean().default(false),
  pendingDir: z.string().default(''),
})

const TRACE_LEVELS: readonly TraceLevel[] = ['debug', 'info', 'warn', 'error']

/**
 * Mount the debug component.
 * @param ctx Host context; registrations are effects scoped to it.
 * @param config Resolved component configuration.
 */
export function apply(ctx: Context, config: Config): void {
  // Debug mode gates the file sink; the ring is on whenever the component is.
  const debugOn = config.debugLog === true || envDebugEnabled()
  const traceFile = join(resolveDshHome(), 'logs', 'dsh-memory-trace.ndjson')
  configureTracing(debugOn ? { file: traceFile } : {})

  const logger = hostLogger(ctx)
  const reporter = activateBootReporter({
    verbose: debugOn,
    emit: (level, message) => logger?.[level]?.(message),
    trace: (state, module, detail) => sharedTracer.log(bootReportLevel(state), 'boot', module, { state, detail }),
  })

  reporter.report('tracer', debugOn ? 'ok' : 'skip',
    debugOn ? `落盘就绪: ${traceFile}` : '仅内存环形缓冲（设 debugLog: true 或环境变量 DSH_MEMORY_LOG=1 启用落盘）')

  ctx.tools.register(defineTool({
    name: 'memory_debug',
    description: '长期记忆诊断：查看本插件最近的运行事件（钩子触发、mem0 请求、候审队列变化、工具调用耗时）。只读，用于排查“记忆为什么没被记住/没被召回”。',
    parameters: {
      limit: { type: 'number', description: '最多返回条数，默认 50，上限 200。' },
      op: { type: 'string', description: '只看某个来源：hook | mem0 | queue | tool | decision | boot。' },
      level: { type: 'string', description: '只看某个级别：debug | info | warn | error。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number', required: true },
          file: { type: 'string', required: true, description: 'NDJSON 落盘路径；未启用时说明启用方法。' },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.count === 0
          ? '最近没有记录事件。'
          : `最近 ${value.count} 条事件（落盘：${value.file}）：\n${value.text}`,
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      const level = args.level !== undefined && TRACE_LEVELS.includes(args.level as TraceLevel)
        ? args.level as TraceLevel
        : undefined
      const events = sharedTracer.recent({
        limit: Math.min(args.limit ?? 50, 200),
        ...args.op === undefined ? {} : { op: args.op },
        ...level === undefined ? {} : { level },
      })
      const text = events
        .map((entry) => `${entry.ts} ${entry.level.toUpperCase()} ${entry.op}/${entry.event}${entry.detail === undefined ? '' : ` ${JSON.stringify(entry.detail)}`}`)
        .join('\n')
      return {
        count: events.length,
        file: sharedTracer.file() ?? '未启用（配置 debugLog: true 或设环境变量 DSH_MEMORY_LOG=1）',
        text: text.length === 0 ? '（环形缓冲为空）' : text,
      }
    },
  }))
  reporter.report('debug-tool', 'ok', 'memory_debug 已注册')

  // Disposing this component (the toggle in the plugin page) must silence every
  // trace output and free the boot slot — that is what "off" means here.
  ctx.effect(() => () => {
    clearBootReporter()
    shutdownTracing()
  }, 'dsh-memory: debug tracing gate')

  // --- async deep checks: files, credentials, one mem0 ping, then the summary ---
  void (async () => {
    const skillBody = await loadSkillBody()
    reporter.report('skill-body', skillBody === undefined ? 'warn' : 'ok',
      skillBody === undefined ? '技能正文缺失（打包不完整），技能列表将为空' : `正文已就绪（${skillBody.length} 字符）`)

    if (debugOn) {
      const traceCheck = await checkTraceFile(traceFile)
      reporter.report(traceCheck.module, traceCheck.state, traceCheck.detail)
    }

    try {
      reporter.report(await checkQueueDir(resolvePendingDir(config), join(resolvePendingDir(config), 'pending.jsonl')))
    } catch (error) {
      reporter.report('queue', 'fail', `队列检查异常：${errorText(error).slice(0, 200)}`)
    }

    let creds: Awaited<ReturnType<typeof resolveMem0Credentials>> | undefined
    try {
      creds = await resolveMem0Credentials(ctx, {})
      // The key is deliberately absent from the report; endpoint and owner id are not secrets.
      reporter.report('credentials', 'ok', `endpoint=${creds.baseUrl} user=${creds.userId}（key 不记录）`)
    } catch (error) {
      reporter.report('credentials', 'fail', errorText(error).replace(/^dsh-memory: /, ''))
    }

    if (creds !== undefined) {
      try {
        const ms = await pingMem0(creds)
        reporter.report('mem0', ms > 2000 ? 'warn' : 'ok', `连通 ${ms}ms（GET /memories topK=1）`)
      } catch (error) {
        if (isMem0Error(error)) {
          const state = error.kind === 'auth' || error.kind === 'network' ? 'fail' : 'warn'
          reporter.report('mem0', state, `${error.kind === 'auth' ? '鉴权失败，检查 MEM0_API_KEY' : `服务异常（${error.kind}）`}：${errorText(error).replace(/^dsh-memory: /, '').slice(0, 200)}`)
        } else {
          reporter.report('mem0', 'fail', `连通性检查异常：${errorText(error).slice(0, 200)}`)
        }
      }
    } else {
      reporter.report('mem0', 'skip', '凭据未解析，跳过连通性检查')
    }

    // Sibling components mount after this plugin and report synchronously; a
    // short settle keeps their lines inside the summary they belong to.
    await new Promise((resolve) => { setTimeout(resolve, 25) })
    reporter.finish()
  })()
}
