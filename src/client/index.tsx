/**
 * The sidebar tab — the review queue's UI door, on the native right sidebar.
 *
 * It talks to the host route (`/memory/pending`) rather than the queue files:
 * the browser side has no filesystem, and the route is where approve/dismiss
 * reuse the same decision flow as the tool.
 *
 * Registration follows the first-party right-sidebar contract (the same path
 * the bundled session inspector takes): `ctx.sidebarRightTabs.register`
 * declares the tab type, and a keyed slot under `sidebar.right.pane.tab`
 * supplies the body — the slot key must equal the definition's `id`. The
 * earlier dsh-better-sidebar route never rendered on the web host: the module
 * loaded and applied fine, but the third-party tab never surfaced in that
 * panel, so this module now rides the native slot system instead.
 *
 * Visuals come from `@deepseek-ai/dsh-client-ui-primitives` (host-supplied at
 * runtime — see vendor-types.d.ts and the client build's neverBundle) and
 * `--dsw-*` alias tokens, so the tab follows the active theme instead of
 * hard-coding colors.
 * @module dsh-memory/client
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
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

/** Tab identity: the slot key under `sidebar.right.pane.tab` equals this id. */
const TAB_ID = 'dsh-memory'
/** Type discriminator used by `openTab` and the guide page. */
const TAB_KIND = 'dsh-memory-pending'

async function requestJson(url: string, init?: RequestInit): Promise<PendingPayload> {
  const response = await fetch(url, init)
  const payload = await response.json() as PendingPayload
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`)
  return payload
}

const shortId = (id: string): string => id.slice(0, 6)

/** Chinese labels for the metadata enums the queue carries. */
const CATEGORY_LABELS: Record<string, string> = {
  fact: '事实',
  preference: '偏好',
  project: '项目',
  person: '人物',
  relation: '关系',
  decision: '决策',
  constraint: '约束',
  goal: '目标',
  workflow: '工作流',
}
const SCOPE_LABELS: Record<string, string> = { user: '用户', project: '项目', agent: 'Agent', session: '会话' }
const IMPORTANCE_LABELS: Record<string, string> = { permanent: '永久', long_term: '长期', temporary: '临时' }
const enumLabel = (map: Record<string, string>, key: string): string => map[key] ?? key

/** The metadata slice this tab renders, with raw strings normalized away. */
function entryMeta(entry: PendingEntryView): { category: string; scope?: string; importance?: string } {
  const meta = entry.metadata ?? {}
  return {
    category: String(meta['category'] ?? ''),
    scope: meta['scope'] === undefined ? undefined : String(meta['scope']),
    importance: meta['importance'] === undefined ? undefined : String(meta['importance']),
  }
}

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
  countBadge: {
    minWidth: '16px', height: '16px', padding: '0 5px', borderRadius: '8px',
    background: 'var(--dsw-alias-border-l4)', color: 'var(--dsw-alias-label-secondary)',
    fontSize: '11px', lineHeight: '16px', textAlign: 'center' as const,
    display: 'inline-block', flexShrink: 0, boxSizing: 'border-box' as const,
  },
  spacer: { flex: 1 },
  quiet: { color: 'var(--dsw-alias-label-tertiary)' },
  /** Small print inside cards (scope line, footer, evidence). */
  meta: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px' },
  secondary: { color: 'var(--dsw-alias-label-secondary)' },
  notice: { color: 'var(--dsw-alias-label-secondary)', marginBottom: '8px' },
  filterRow: { marginBottom: '10px' },
  list: { listStyle: 'none', padding: 0, margin: 0 },
  card: {
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: 'var(--dsw-radius-md, 8px)',
    background: 'var(--dsw-alias-bg-layer-2)',
    padding: '10px 12px',
    marginBottom: '8px',
  },
  cardHeader: { display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px', cursor: 'pointer' as const, userSelect: 'none' as const },
  chevron: {
    display: 'inline-block', flexShrink: 0, fontSize: '10px', color: 'var(--dsw-alias-label-tertiary)',
    transition: 'transform 0.15s ease',
  },
  itemText: { fontSize: '12px', lineHeight: 1.55, whiteSpace: 'pre-wrap', wordBreak: 'break-word' as const, marginBottom: '6px', cursor: 'pointer' as const },
  clamp: {
    display: '-webkit-box',
    WebkitBoxOrient: 'vertical' as const,
    WebkitLineClamp: 2,
    overflow: 'hidden',
  },
  footer: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', marginBottom: '8px' },
  track: {
    width: '56px', height: '4px', borderRadius: 'var(--dsw-radius-sm)',
    background: 'var(--dsw-alias-border-l4)', overflow: 'hidden', flexShrink: 0,
  },
  evidence: { color: 'var(--dsw-alias-label-tertiary)', fontSize: '11px', marginBottom: '8px' },
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
      // payload.text is the machine-oriented queue summary; the card list
      // below already shows everything it says, so it is not rendered.
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

/** What the pane's inject callback hands the body: the owning Session id. */
export interface MemoryInjected {
  sessionId?: string
}

/** Props the slot system assembles for the tab body. */
export type MemoryTabProps = { injected?: MemoryInjected }

/** The registered tab body. */
export function MemoryPendingTab({ injected }: MemoryTabProps): ReactNode {
  const { entries, message, busy, refresh, decide } = usePendingQueue()
  const [filter, setFilter] = useState<string>('all')
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const session = injected?.sessionId

  const toggle = useCallback((id: string) => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const categories = useMemo(() => {
    const set = new Set<string>()
    for (const entry of entries) {
      const meta = entryMeta(entry)
      set.add(meta.category === '' ? '未分类' : meta.category)
    }
    return [...set].sort()
  }, [entries])

  const visible = useMemo(
    () => filter === 'all'
      ? entries
      : entries.filter((entry) => {
        const meta = entryMeta(entry)
        return (meta.category === '' ? '未分类' : meta.category) === filter
      }),
    [entries, filter],
  )

  const filterTabs = useMemo(() => {
    const tabs: [SegmentedTab<string>, ...SegmentedTab<string>[]] = [
      { value: 'all', label: `全部 ${entries.length}`, id: 'dsh-memory-tab-all', panelId: 'dsh-memory-panel-all' },
      ...categories.map((category) => ({
        value: category,
        label: enumLabel(CATEGORY_LABELS, category),
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
        {entries.length === 0 ? null : <span style={styles.countBadge}>{entries.length}</span>}
        <div style={styles.spacer} />
        <Button variant="ghost" size="sm" onClick={() => { void refresh() }} disabled={busy}>刷新</Button>
      </div>
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
            const meta = entryMeta(entry)
            const isExpanded = expanded.has(entry.id)
            const percent = Math.round(Math.min(Math.max(entry.confidence, 0), 1) * 100)
            const scopeText = [meta.scope && enumLabel(SCOPE_LABELS, meta.scope), meta.importance && enumLabel(IMPORTANCE_LABELS, meta.importance)]
              .filter((part) => typeof part === 'string').join(' · ')
            return (
              <li key={entry.id} style={styles.card}>
                <div style={styles.cardHeader} onClick={() => toggle(entry.id)}>
                  <Tag tone="neutral">{meta.category === '' ? '未分类' : enumLabel(CATEGORY_LABELS, meta.category)}</Tag>
                  {scopeText === '' ? null : <span style={styles.meta}>{scopeText}</span>}
                  <div style={styles.spacer} />
                  <span
                    style={{ ...styles.chevron, transform: isExpanded ? 'rotate(90deg)' : 'none' }}
                    aria-expanded={isExpanded}
                  >▶</span>
                </div>
                <div
                  style={{ ...styles.itemText, ...(isExpanded ? {} : styles.clamp) }}
                  onClick={() => toggle(entry.id)}
                  title={isExpanded ? '点击折叠' : '点击展开全文'}
                >
                  {entry.text}
                </div>
                <div style={styles.footer}>
                  <span style={styles.quiet} title={`条目 ID：${entry.id}（日志排查用）`}>#{shortId(entry.id)}</span>
                  <div style={styles.track} title={`置信度 ${percent}%`}>
                    <div style={{
                      width: `${percent}%`,
                      height: '100%',
                      background: confidenceColor(entry.confidence),
                    }} />
                  </div>
                  <span style={styles.quiet}>置信度 {percent}%</span>
                </div>
                {isExpanded && entry.evidence !== undefined ? (
                  <div style={styles.evidence}>来源：{entry.evidence}</div>
                ) : null}
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

/**
 * Narrow faces of the two first-party services this module touches, matching
 * the shapes used by the bundled session inspector. Kept structural (instead
 * of importing the packages) so the published manifest carries no hard
 * dependency on internal UI packages.
 */
interface SidebarRightTabsService {
  register(definition: {
    id: string
    kind: string
    title: (address: string) => string
    guide?: readonly { id: string; order: number; title: () => string; description: () => string }[]
  }): () => void
}

interface SlotsService {
  inject(name: string, factory: () => unknown): unknown
  register(options: Record<string, unknown>, component: unknown): () => void
}

/** cordis services required to register the sidebar tab. */
export const inject = ['slots', 'sidebarRightTabs']

export const name = 'memory-tab'

/**
 * Register the tab on the native right sidebar for this plugin's lifetime.
 * @param ctx Client plugin context.
 */
export function apply(ctx: Context): void {
  const faces = ctx as unknown as {
    slots?: SlotsService
    sidebarRightTabs?: SidebarRightTabsService
    logger?: { warn?(message: string): unknown }
  }
  const { slots, sidebarRightTabs } = faces
  if (slots === undefined || sidebarRightTabs === undefined) {
    faces.logger?.warn?.('dsh-memory: slots/sidebarRightTabs 服务缺失，待审 Tab 未注册')
    return
  }
  ctx.effect(() => sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    title: () => '记忆待审',
    guide: [{
      id: 'open', order: 60, title: () => '记忆待审',
      description: () => '候审的候选事实：批准后写入 mem0，驳回后不再询问。',
    }],
  }), 'dsh-memory: sidebar tab')
  slots.inject('sidebar.right.pane.tab', () => slots.register({
    name: 'sidebar.right.pane.tab',
    key: TAB_ID,
    inject: (sessionId: string): MemoryInjected => ({ sessionId }),
  }, MemoryPendingTab))
}
