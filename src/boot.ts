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

import { readFile, stat } from 'node:fs/promises'
import type { Mem0Credentials } from './credentials.ts'
import { createMem0Client } from './mem0.ts'
import { parseEntries } from './queue.ts'

export type BootState = 'ok' | 'warn' | 'fail' | 'skip'

/** One module's startup verdict. */
export interface BootLine {
  module: string
  state: BootState
  detail: string
}

/** Log levels the host logger may offer; every one is optional. */
export type BootLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface BootReporterOptions {
  /** Per-module detail lines print only in debug mode; warn/fail always print. */
  verbose: boolean
  emit(level: BootLogLevel, message: string): void
  trace(state: BootState, module: string, detail: string): void
}

export interface BootReporter {
  report(module: string, state: BootState, detail: string): void
  report(line: BootLine): void
  /** Emit the summary line; call once after the last module has reported. */
  finish(): void
  lines(): readonly BootLine[]
}

const STATE_LABEL: Record<BootState, string> = { ok: 'OK', warn: 'WARN', fail: 'FAIL', skip: 'SKIP' }
const STATE_LEVEL: Record<BootState, BootLogLevel> = { ok: 'debug', warn: 'warn', fail: 'error', skip: 'debug' }

/** The log level a boot state speaks at; shared with the trace ring. */
export function bootReportLevel(state: BootState): BootLogLevel {
  return STATE_LEVEL[state]
}

/** Build the boot reporter. `finish()` may be called once; later calls are no-ops. */
export function createBootReporter(options: BootReporterOptions): BootReporter {
  const lines: BootLine[] = []
  let finished = false

  const report = (module: string | BootLine, state?: BootState, detail?: string): void => {
    if (finished) return
    const line: BootLine = typeof module === 'string'
      ? { module, state: state as BootState, detail: detail as string }
      : module
    lines.push(line)
    options.trace(line.state, line.module, line.detail)
    if (options.verbose || line.state === 'warn' || line.state === 'fail') {
      options.emit(STATE_LEVEL[line.state], `dsh-memory [boot] ${line.module}: ${STATE_LABEL[line.state]} — ${line.detail}`)
    }
  }

  return {
    report,

    finish() {
      if (finished || lines.length === 0) return
      finished = true
      const count = (state: BootState): number => lines.filter((line) => line.state === state).length
      const ok = count('ok')
      const warn = count('warn')
      const fail = count('fail')
      const skip = count('skip')
      const summary = `dsh-memory [boot] 自检完成：${lines.length} 模块（ok=${ok} warn=${warn} fail=${fail} skip=${skip}）`
      const state: BootState = fail > 0 ? 'fail' : warn > 0 ? 'warn' : 'ok'
      options.trace(state, 'summary', `ok=${ok} warn=${warn} fail=${fail} skip=${skip}`)
      if (options.verbose || fail > 0 || warn > 0) {
        options.emit(STATE_LEVEL[state], summary)
      }
    },

    lines: () => lines,
  }
}

/** Queue boot check: pending count, and malformed lines that parsing had to drop. */
export async function checkQueueDir(dir: string, jsonlPath: string): Promise<BootLine> {
  let raw: string
  try {
    raw = await readFile(jsonlPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { module: 'queue', state: 'ok', detail: `队列为空（${dir}）` }
    }
    return { module: 'queue', state: 'fail', detail: `队列文件不可读：${error instanceof Error ? error.message : String(error)}` }
  }
  const physical = raw.split('\n').filter((line) => line.trim().length > 0).length
  const entries = parseEntries(raw)
  const malformed = physical - entries.length
  const pending = entries.filter((entry) => entry.status === 'pending').length
  if (malformed > 0) {
    return { module: 'queue', state: 'warn', detail: `${pending} 待审 / ${entries.length} 有效；${malformed} 行损坏被忽略（中断写入残留）` }
  }
  if (pending > 50) {
    return { module: 'queue', state: 'warn', detail: `待审积压 ${pending} 条（${dir}）——尽快审阅` }
  }
  return { module: 'queue', state: 'ok', detail: `${pending} 待审 / ${entries.length} 总数（${dir}）` }
}

/** Tracer file-sink boot check: the directory must exist and be writable. */
export async function checkTraceFile(file: string): Promise<BootLine> {
  try {
    await stat(file)
    return { module: 'tracer', state: 'ok', detail: `落盘文件已存在（追加模式）: ${file}` }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { module: 'tracer', state: 'warn', detail: `落盘文件不可访问：${error instanceof Error ? error.message : String(error)}` }
    }
    return { module: 'tracer', state: 'ok', detail: `落盘就绪（首次写入创建）: ${file}` }
  }
}

/** mem0 reachability: one cheap authenticated GET, measured. */
export async function pingMem0(
  creds: Mem0Credentials,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<number> {
  const started = Date.now()
  const client = createMem0Client({
    baseUrl: creds.baseUrl,
    apiKey: creds.apiKey,
    userId: creds.userId,
    ...options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
    ...options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl },
  })
  await client.inventory({ topK: 1 })
  return Date.now() - started
}

// --- shared boot slot --------------------------------------------------------
//
// The debug component owns the boot report; the other four components report
// their own mount lines into whatever reporter is active when they start. No
// active reporter means the debug component is disabled, and a healthy boot
// stays silent — sibling failures still surface through their own logger.warn
// paths, so a broken mount is never swallowed.

let active: BootReporter | undefined

/** Install a fresh reporter (the debug component mounts); later ones replace it. */
export function activateBootReporter(options: BootReporterOptions): BootReporter {
  active = createBootReporter(options)
  return active
}

/** The reporter sibling components report into, or `undefined` when debug is off. */
export function activeBootReporter(): BootReporter | undefined {
  return active
}

/** Drop the slot; called when the debug component is disposed. */
export function clearBootReporter(): void {
  active = undefined
}
