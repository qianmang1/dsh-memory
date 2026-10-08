/**
 * mem0 REST client — the TS replacement for the Python MCP bridge.
 *
 * The contract was measured against the running service (2026-10-08):
 * auth is `X-API-Key`, list/search responses are `{results:[…]}`, every row
 * carries a server-side `hash`, and writes accept `infer:false` to skip fact
 * extraction. Two behaviours are deliberate, not incidental:
 *
 * - `top_k` is the size parameter. The bridge sent `limit`, which the service
 *   ignores while still returning its default 20 rows, so category/scope
 *   filtering silently under-reported. `recall` therefore sends `top_k` and
 *   filters client-side afterwards.
 * - "Supersede" is a data shape, not an endpoint: the old row is rewritten with
 *   `metadata.status=historical` and the new row carries `metadata.supersedes`.
 * @module dsh-memory/mem0
 */

/** Metadata fields this plugin reads and writes; unknown keys are preserved as-is by the service. */
export interface MemoryMetadata {
  category?: string
  scope?: string
  importance?: string
  project?: string
  source?: string
  status?: string
  tags?: string[]
  supersedes?: string
}

/** One memory row, narrowed to the fields this plugin relies on. */
export interface MemoryRow {
  id: string
  memory: string
  hash?: string
  metadata: MemoryMetadata
  createdAt?: string
  updatedAt?: string
  score?: number
}

/** Failure classes the caller can act on; `auth` and `network` are retry/config distinct from a bad request. */
export type Mem0ErrorKind = 'network' | 'auth' | 'client' | 'server'

/** A mem0 call that failed, classified by what the caller can do about it. */
export class Mem0Error extends Error {
  /** Which failure class this is. */
  readonly kind: Mem0ErrorKind
  /** HTTP status when one was received. */
  readonly status?: number

  constructor(message: string, kind: Mem0ErrorKind, status?: number) {
    super(message)
    this.name = 'Mem0Error'
    this.kind = kind
    if (status !== undefined) this.status = status
  }
}

export interface Mem0ClientOptions {
  baseUrl: string
  apiKey: string
  userId: string
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
  /** Per-request budget; hooks pass a tighter value because their handles are abandoned on timeout. */
  timeoutMs?: number
}

export interface RecallOptions {
  query: string
  topK?: number
  category?: string
  scope?: string
  includeHistorical?: boolean
}

export interface RememberInput {
  text: string
  metadata?: MemoryMetadata
  /** When true the service extracts facts and may rewrite the text; default false keeps the wording. */
  infer?: boolean
}

export interface SupersedeInput {
  oldId: string
  text: string
  metadata?: MemoryMetadata
  source?: string
}

export interface InventoryOptions {
  topK?: number
  category?: string
  status?: string
  scope?: string
  importance?: string
}

/** The client surface used by tools, hooks, and the review queue. */
export interface Mem0Client {
  recall(options: RecallOptions): Promise<MemoryRow[]>
  inventory(options?: InventoryOptions): Promise<MemoryRow[]>
  read(id: string): Promise<MemoryRow | undefined>
  remember(input: RememberInput): Promise<MemoryRow[]>
  supersede(input: SupersedeInput): Promise<{ supersededId: string; created: MemoryRow[] }>
}

const DEFAULT_TIMEOUT_MS = 15_000

/** Map one service row into the narrow shape callers use. */
export function toMemoryRow(raw: unknown): MemoryRow | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const row = raw as Record<string, unknown>
  const id = typeof row['id'] === 'string' ? row['id'] : undefined
  const memory = typeof row['memory'] === 'string' ? row['memory'] : undefined
  if (id === undefined || memory === undefined) return undefined
  const metadata = typeof row['metadata'] === 'object' && row['metadata'] !== null
    ? row['metadata'] as MemoryMetadata
    : {}
  const hash = typeof row['hash'] === 'string' ? row['hash'] : undefined
  const createdAt = typeof row['created_at'] === 'string' ? row['created_at'] : undefined
  const updatedAt = typeof row['updated_at'] === 'string' ? row['updated_at'] : undefined
  const score = typeof row['score'] === 'number' ? row['score'] : undefined
  return {
    id,
    memory,
    metadata,
    ...hash === undefined ? {} : { hash },
    ...createdAt === undefined ? {} : { createdAt },
    ...updatedAt === undefined ? {} : { updatedAt },
    ...score === undefined ? {} : { score },
  }
}

/** Unwrap the `{results:[…]}` envelope; a bare array is accepted too. */
export function toRows(payload: unknown): MemoryRow[] {
  const list = Array.isArray(payload)
    ? payload
    : typeof payload === 'object' && payload !== null && Array.isArray((payload as { results?: unknown }).results)
      ? (payload as { results: unknown[] }).results
      : []
  return list.map(toMemoryRow).filter((row): row is MemoryRow => row !== undefined)
}

/** Client-side filter that mirrors the semantics the Python bridge applied after searching. */
export function filterRows(
  rows: readonly MemoryRow[],
  options: { category?: string; scope?: string; includeHistorical?: boolean },
): MemoryRow[] {
  return rows.filter((row) => {
    if (options.includeHistorical !== true && row.metadata.status === 'historical') return false
    if (options.category !== undefined && row.metadata.category !== options.category) return false
    if (options.scope !== undefined && row.metadata.scope !== options.scope) return false
    return true
  })
}

/**
 * Build the client over one resolved credential triple.
 * @param options Endpoint, key, owner, and test seams.
 * @returns The client.
 */
export function createMem0Client(options: Mem0ClientOptions): Mem0Client {
  const doFetch = options.fetchImpl ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const request = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const url = `${options.baseUrl}${path}`
    let response: Response
    try {
      response = await doFetch(url, {
        method,
        headers: {
          'X-API-Key': options.apiKey,
          'Content-Type': 'application/json',
        },
        ...body === undefined ? {} : { body: JSON.stringify(body) },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Mem0Error(`dsh-memory: mem0 请求失败（网络）: ${method} ${path} — ${reason}`, 'network')
    }
    const text = await response.text()
    if (!response.ok) {
      const detail = text.slice(0, 500)
      const kind: Mem0ErrorKind = response.status === 401 || response.status === 403
        ? 'auth'
        : response.status >= 500 ? 'server' : 'client'
      throw new Mem0Error(
        `dsh-memory: mem0 ${method} ${path} -> HTTP ${response.status}: ${detail}`,
        kind,
        response.status,
      )
    }
    if (text.trim().length === 0) return {}
    try {
      return JSON.parse(text) as unknown
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Mem0Error(`dsh-memory: mem0 返回了非 JSON 响应: ${method} ${path} — ${reason}`, 'server')
    }
  }

  return {
    async recall(input) {
      // `top_k`, never `limit`: the service ignores `limit` and answers with its
      // default page, which made filtered searches under-report.
      const payload = await request('POST', '/search', {
        query: input.query,
        user_id: options.userId,
        top_k: input.topK ?? 10,
      })
      const rows = toRows(payload)
      return filterRows(rows, {
        ...input.category === undefined ? {} : { category: input.category },
        ...input.scope === undefined ? {} : { scope: input.scope },
        ...input.includeHistorical === undefined ? {} : { includeHistorical: input.includeHistorical },
      })
    },

    async inventory(input = {}) {
      const params = new URLSearchParams({ user_id: options.userId, top_k: String(input.topK ?? 50) })
      const rows = toRows(await request('GET', `/memories?${params.toString()}`))
      return rows.filter((row) => {
        if (input.category !== undefined && row.metadata.category !== input.category) return false
        if (input.status !== undefined && (row.metadata.status ?? 'current') !== input.status) return false
        if (input.scope !== undefined && row.metadata.scope !== input.scope) return false
        if (input.importance !== undefined && row.metadata.importance !== input.importance) return false
        return true
      })
    },

    async read(id) {
      const payload = await request('GET', `/memories/${encodeURIComponent(id)}`)
      return toMemoryRow(payload)
    },

    async remember(input) {
      const payload = await request('POST', '/memories', {
        user_id: options.userId,
        messages: [{ role: 'user', content: input.text }],
        metadata: input.metadata ?? {},
        // Faithful by default: the service's extractor may rewrite wording, so
        // it is opt-in per call rather than the default.
        infer: input.infer ?? false,
      })
      const rows = toRows(payload)
      // The service answers with the affected rows; an empty envelope means the
      // write was accepted without an echo, which is not an error.
      return rows
    },

    async supersede(input) {
      const existing = await request('GET', `/memories/${encodeURIComponent(input.oldId)}`)
      const old = toMemoryRow(existing)
      const supersededId = old?.id ?? input.oldId
      const keep: MemoryMetadata = {}
      if (old?.metadata.category !== undefined) keep.category = old.metadata.category
      if (old?.metadata.scope !== undefined) keep.scope = old.metadata.scope
      if (old?.metadata.importance !== undefined) keep.importance = old.metadata.importance
      if (old?.metadata.project !== undefined) keep.project = old.metadata.project
      if (old?.metadata.source !== undefined) keep.source = old.metadata.source
      if (old?.metadata.tags !== undefined) keep.tags = old.metadata.tags

      await request('PUT', `/memories/${encodeURIComponent(supersededId)}`, {
        text: old?.memory ?? 'superseded',
        metadata: { ...keep, status: 'historical' },
      })
      const created = await request('POST', '/memories', {
        user_id: options.userId,
        messages: [{ role: 'user', content: input.text }],
        metadata: {
          ...input.metadata,
          status: 'current',
          supersedes: supersededId,
          ...input.source === undefined ? {} : { source: input.source },
        },
        infer: false,
      })
      return { supersededId, created: toRows(created) }
    },
  }
}
