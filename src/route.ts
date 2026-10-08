/**
 * The pending-review route — what a sidebar tab calls.
 *
 * Split in two on purpose: `handlePendingRequest` is the whole behaviour and is
 * testable without an HTTP server; `registerPendingRoute` is the thin adapter
 * onto the host's webServer. The route is opportunistic like the skill — a host
 * without a webServer keeps the tools, the hooks, and the queue.
 *
 * Approve/dismiss delegate to `decisions.ts`, so the sidebar cannot drift from
 * the tool's order (dedupe → supersede or faithful write → record).
 * @module dsh-memory/route
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { approveEntry, dismissEntry, pendingView, type DecisionDeps } from './decisions.ts'

/** Route prefix the tab and the host both address. */
export const PENDING_PREFIX = '/memory/pending'

export interface PendingRequest {
  method: string
  path: string
  body?: unknown
}

export interface PendingResponse {
  status: number
  body: Record<string, unknown>
}

/** A request-shaped view of the queue, or a decision applied to it. */
export async function handlePendingRequest(deps: DecisionDeps, request: PendingRequest): Promise<PendingResponse> {
  if (request.method === 'GET') {
    const view = pendingView(await deps.queue.list())
    return { status: 200, body: { ok: true, text: view.text, entries: view.entries } }
  }
  if (request.method !== 'POST') {
    return { status: 405, body: { ok: false, error: 'method not allowed' } }
  }

  const body = typeof request.body === 'object' && request.body !== null
    ? request.body as Record<string, unknown>
    : {}
  const id = typeof body['id'] === 'string' ? body['id'] : undefined
  const note = typeof body['note'] === 'string' ? body['note'] : undefined
  if (id === undefined) return { status: 400, body: { ok: false, error: 'id is required' } }

  if (!request.path.endsWith('/approve') && !request.path.endsWith('/dismiss')) {
    return { status: 404, body: { ok: false, error: `未知路径 ${request.path}（GET 列表 / POST …/approve / POST …/dismiss）` } }
  }
  const result = request.path.endsWith('/approve')
    ? await approveEntry(deps, id, note)
    : await dismissEntry(deps.queue, id, note)
  return {
    status: result.ok ? 200 : 404,
    body: {
      ok: result.ok,
      text: result.text,
      ...result.entry === undefined ? {} : { entry: result.entry },
    },
  }
}

/** The webServer surface this module uses. */
interface RouteRegistrar {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }): () => void
}

/** The host surface this module touches; `Context` satisfies it. */
export interface RouteHost {
  get?(key: string): unknown
  effect?(register: () => () => void, name?: string): unknown
  logger?: { warn?(message: string): unknown }
}

/** Read a JSON body, tolerating an empty or malformed one (the caller reports 400). */
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let raw = ''
  for await (const chunk of request) raw += String(chunk)
  if (raw.trim().length === 0) return undefined
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

/**
 * Publish the route when the host exposes a webServer.
 * @param ctx Host context (only `get`, an optional `effect`, and a logger are used).
 * @param deps Queue, client factory, and the dedupe threshold.
 */
export function registerPendingRoute(ctx: RouteHost, deps: DecisionDeps): void {
  const webServer = ctx.get?.('webServer') as RouteRegistrar | undefined
  if (typeof webServer?.register !== 'function') return
  try {
    const dispose = webServer.register({
      kind: 'prefix',
      path: PENDING_PREFIX,
      handler: async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://dsh.internal')
        const result = await handlePendingRequest(deps, {
          method: request.method ?? 'GET',
          path: url.pathname,
          ...request.method === 'POST' ? { body: await readJsonBody(request) } : {},
        })
        response.statusCode = result.status
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify(result.body))
      },
    })
    ctx.effect?.(() => dispose, 'dsh-memory: pending review route')
  } catch (error) {
    ctx.logger?.warn?.(`dsh-memory: 候审路由注册失败: ${error instanceof Error ? error.message : String(error)}`)
  }
}
