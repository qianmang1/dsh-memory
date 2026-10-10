/**
 * The sidebar tab — the review queue's UI door.
 *
 * It talks to the host route (`/memory/pending`) rather than the queue files:
 * the browser side has no filesystem, and the route is where approve/dismiss
 * reuse the same decision flow as the tool.
 *
 * Visuals come from `@deepseek-ai/dsh-client-ui-primitives` (host-supplied at
 * runtime — see vendor-types.d.ts and the client build's neverBundle) and
 * `--dsw-*` alias tokens, so the tab follows the active theme instead of
 * hard-coding colors.
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

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { TabComponentProps, TabDescriptor } from 'dsh-better-sidebar'
import { Button, SegmentedTabs, Tag, TextShimmer } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SegmentedTab } from '@deepseek-ai/dsh-client-ui-primitives'

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

/** Poll cadence for the queue; the tab only refreshes while visible. */
const POLL_MS = 15_000

async function requestJson(url: string, init?: RequestInit): Promise<PendingPayload> {
  const response = await fetch(url, init)
  const payload = await response.json() as PendingPayload
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
  return payload
}

const shortId = (id: string): string => id.slice(0, 6)

/** Colors for the confidence bar, keyed off the --dsw state aliases. */
function confidenceColor(confidence: number): string {
  if (confidence >= 0.8) return 'var(--dsw-alias-state-success-primary)'
  if (confidence >= 0.6) return 'var(--dsw-alias-state-business-primary)'
  return 'var(--dsw-alias-state-warn-primary)'
}

/** Alias tokens used by this tab; kept in one place for easy auditing. */
const styles = {
  root: { padding: '12px', fontSize: 'var(--dsw-font-xs-13)', lineHeight: 1.6, color: 'var(--dsw-alias-label-primary)' },
  header: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' },
  title: { fontWeight: 600 },
  spacer: { flex: 1 },
  quiet: { color: 'var(--dsw-alias-label-tertiary)' },
  secondary: { color: 'var(--dsw-alias-label-secondary)' },
  notice: { color: 'var(--dsw-alias-label-secondary)', marginBottom: '8px' },
  filterRow: { marginBottom: '10px' },
  list: { listStyle: 'none', padding: 0, margin: 0 },
  item: { borderBottom: '1px solid var(--dsw-alias-border-l2)', padding: '10px 0' },
  itemText: { whiteSpace: 'pre-wrap', wordBreak: 'break-word' as const, marginBottom: '4px' },
  metaRow: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', marginBottom: '6px' },
  track: {
    width: '56px', height: '4px', borderRadius: 'var(--dsw-radius-sm)',
    background: 'var(--dsw-alias-border-l4)', overflow: 'hidden', flexShrink: 0,
  },
  actions: { display: 'flex', gap: '8px' },
  empty: { padding: '24px 0', textAlign: 'center' as const },
}

/**
 * Fetch the pending view once, after every decision, and on a visibility-gated
 * poll so the tab picks up captures made while the user was reading.
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

  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, POLL_MS)
    return () => { clearInterval(timer) }
  }, [refresh])

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
  const [filter, setFilter] = useState<string>('all')
  const session = scope?.sessionId

  const categories = useMemo(() => {
    const set = new Set<string>()
    for (const entry of entries) {
      set.add(String(entry.metadata?.['category'] ?? '未分类'))
    }
    return [...set].sort()
  }, [entries])

  const visible = useMemo(
    () => filter === 'all' ? entries : entries.filter((entry) => String(entry.metadata?.['category'] ?? '未分类') === filter),
    [entries, filter],
  )

  const filterTabs = useMemo(() => {
    const tabs: [SegmentedTab<string>, ...SegmentedTab<string>[]] = [
      { value: 'all', label: `全部 ${entries.length}`, id: 'dsh-memory-tab-all', panelId: 'dsh-memory-panel-all' },
      ...categories.map((category) => ({
        value: category,
        label: category,
        id: `dsh-memory-tab-${category}`,
        panelId: `dsh-memory-panel-${category}`,
      })),
    ]
    return tabs
  }, [categories, entries.length])

  return (
    <div style={styles.root}>
      <div style={styles.header}>
        <strong style={styles.title}>记忆待审</strong>
        {entries.length === 0 ? null : <Tag tone="solid">{entries.length}</Tag>}
        <div style={styles.spacer} />
        <Button variant="ghost" size="sm" onClick={() => { void refresh() }} disabled={busy}>刷新</Button>
      </div>
      {session === undefined ? null : <div style={{ ...styles.quiet, marginBottom: '8px' }}>会话 {session.slice(0, 8)}</div>}
      {message === undefined ? null : <div style={styles.notice}>{message}</div>}
      {categories.length > 1 ? (
        <div style={styles.filterRow}>
          <SegmentedTabs items={filterTabs} value={filter} onChange={setFilter} label="按分类筛选" />
        </div>
      ) : null}
      {busy && entries.length === 0 ? (
        <TextShimmer active><div style={styles.quiet}>读取待审队列…</div></TextShimmer>
      ) : entries.length === 0 ? (
        <div style={{ ...styles.empty, ...styles.quiet }}>
          队列为空
          <div style={{ fontSize: '12px', marginTop: '4px' }}>捕获组件产生候选记忆后会出现在这里</div>
        </div>
      ) : visible.length === 0 ? (
        <div style={{ ...styles.empty, ...styles.quiet }}>该分类下没有待审条目</div>
      ) : (
        <ul style={styles.list}>
          {visible.map((entry) => {
            const category = String(entry.metadata?.['category'] ?? '未分类')
            return (
              <li key={entry.id} style={styles.item}>
                <div style={styles.itemText}>{entry.text}</div>
                <div style={styles.metaRow}>
                  <Tag tone="neutral">{category}</Tag>
                  <span style={styles.quiet} title={`置信度 ${entry.confidence.toFixed(2)}`}>{shortId(entry.id)}</span>
                  <div style={styles.track} title={`置信度 ${entry.confidence.toFixed(2)}`}>
                    <div style={{
                      width: `${Math.round(Math.min(Math.max(entry.confidence, 0), 1) * 100)}%`,
                      height: '100%',
                      background: confidenceColor(entry.confidence),
                    }} />
                  </div>
                  <span style={styles.quiet}>conf {entry.confidence.toFixed(2)}</span>
                </div>
                {entry.evidence === undefined ? null : (
                  <div style={{ ...styles.quiet, fontSize: '12px', marginBottom: '6px' }}>证据：{entry.evidence}</div>
                )}
                <div style={styles.actions}>
                  <Button variant="primary" size="sm" disabled={busy} onClick={() => { void decide(entry.id, 'approve') }}>批准</Button>
                  <Button variant="outline" size="sm" disabled={busy} onClick={() => { void decide(entry.id, 'dismiss') }}>驳回</Button>
                </div>
              </li>
            )
          })}
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
