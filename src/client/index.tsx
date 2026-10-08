/**
 * The sidebar tab — the review queue's UI door.
 *
 * It talks to the host route (`/memory/pending`) rather than the queue files:
 * the browser side has no filesystem, and the route is where approve/dismiss
 * reuse the same decision flow as the tool.
 *
 * `ctx.betterSidebar` stays optional at runtime: it is reached with `ctx.get`,
 * never `inject`, so a host without the sidebar keeps the tools, hooks, and
 * queue (the reviewer then uses `memory_review`). That optionality lives in the
 * runtime lookup only — the descriptor and props types come from
 * `dsh-better-sidebar` itself (a devDependency, absent from the published
 * manifest), so a renamed field fails `npm run typecheck` instead of silently
 * rendering nothing.
 * @module dsh-memory/client
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { TabComponentProps, TabDescriptor } from 'dsh-better-sidebar'

/** One candidate as the route serializes it. */
interface PendingEntryView {
  id: string
  text: string
  confidence: number
  metadata?: Record<string, unknown>
  status: string
  evidence?: string
}

interface PendingPayload {
  ok: boolean
  text?: string
  entries?: PendingEntryView[]
  error?: string
}

/** The route this tab calls; same constant the host registers. */
const PENDING_ENDPOINT = '/memory/pending'

async function requestJson(url: string, init?: RequestInit): Promise<PendingPayload> {
  const response = await fetch(url, init)
  const payload = await response.json() as PendingPayload
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
  return payload
}

const shortId = (id: string): string => id.slice(0, 6)

/**
 * Fetch the pending view once and after every decision.
 * @returns State and actions for the tab body.
 */
export function usePendingQueue(): {
  entries: PendingEntryView[]
  message: string | undefined
  busy: boolean
  refresh: () => Promise<void>
  decide: (id: string, action: 'approve' | 'dismiss') => Promise<void>
} {
  const [entries, setEntries] = useState<PendingEntryView[]>([])
  const [message, setMessage] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      const payload = await requestJson(PENDING_ENDPOINT)
      setEntries(payload.entries ?? [])
      setMessage(payload.text)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [])

  const decide = useCallback(async (id: string, action: 'approve' | 'dismiss') => {
    setBusy(true)
    try {
      const payload = await requestJson(`${PENDING_ENDPOINT}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, note: 'sidebar' }),
      })
      setMessage(payload.text)
      await refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
      setBusy(false)
    }
  }, [refresh])

  useEffect(() => { void refresh() }, [refresh])

  return { entries, message, busy, refresh, decide }
}

/**
 * Props every sidebar tab receives, narrowed to what this tab reads.
 *
 * Typed against the sidebar's own declaration so a field rename in
 * `dsh-better-sidebar` fails `npm run typecheck` instead of silently rendering
 * an empty value. `SessionScope.sessionId` is required there; this component
 * treats it as optional because `scope` arrives from the host at render time.
 */
export type TabProps = Pick<TabComponentProps, 'scope'>

/** The registered tab body. */
export function MemoryPendingTab({ scope }: TabProps): ReactNode {
  const { entries, message, busy, refresh, decide } = usePendingQueue()
  const session = scope?.sessionId

  return (
    <div style={{ padding: '12px', fontSize: '13px', lineHeight: 1.6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
        <strong>记忆待审</strong>
        <button type="button" onClick={() => { void refresh() }} disabled={busy}>刷新</button>
      </div>
      {session === undefined ? null : (
        <div style={{ opacity: 0.6, marginBottom: '8px' }}>会话 {session.slice(0, 8)}</div>
      )}
      {message === undefined ? null : <div style={{ opacity: 0.8, marginBottom: '8px' }}>{message}</div>}
      {entries.length === 0 ? null : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {entries.map((entry) => (
            <li key={entry.id} style={{ borderTop: '1px solid currentColor', padding: '8px 0' }}>
              <div>{entry.text}</div>
              <div style={{ opacity: 0.6, fontSize: '12px' }}>
                [{shortId(entry.id)}] {String(entry.metadata?.['category'] ?? '未分类')} · conf {entry.confidence.toFixed(2)}
              </div>
              {entry.evidence === undefined ? null : (
                <div style={{ opacity: 0.6, fontSize: '12px' }}>证据：{entry.evidence}</div>
              )}
              <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
                <button type="button" disabled={busy} onClick={() => { void decide(entry.id, 'approve') }}>批准</button>
                <button type="button" disabled={busy} onClick={() => { void decide(entry.id, 'dismiss') }}>驳回</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** The `ctx.betterSidebar` surface this module uses, from the sidebar's own types. */
type SidebarService = {
  registerTab(descriptor: TabDescriptor): () => void
}

/** The client context surface this module touches. */
export interface ClientHost {
  get?(key: string): unknown
  effect?(register: () => () => void, name?: string): unknown
  logger?: { warn?(message: string): unknown }
}

export const name = 'memory-tab'

/**
 * Register the tab when the sidebar plugin is present.
 * @param ctx Client context.
 */
export function apply(ctx: ClientHost): void {
  const sidebar = ctx.get?.('betterSidebar') as SidebarService | undefined
  if (typeof sidebar?.registerTab !== 'function') return
  try {
    const dispose = sidebar.registerTab({
      id: 'dsh-memory:pending',
      title: '记忆待审',
      description: '候审的候选事实：批准后写入 mem0，驳回后不再询问。',
      order: 60,
      component: MemoryPendingTab,
    })
    ctx.effect?.(() => dispose, 'dsh-memory: pending tab')
  } catch (error) {
    ctx.logger?.warn?.(`dsh-memory: 待审 Tab 注册失败: ${error instanceof Error ? error.message : String(error)}`)
  }
}
