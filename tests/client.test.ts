import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { apply, MemoryPendingTab } from '../src/client/index.tsx'

// No JSX here on purpose: Node strips types from `.ts` but has no loader for
// `.tsx`, so the tests build elements with createElement instead of pulling in a
// JSX runtime for the test process.

describe('pending tab', () => {
  it('renders its chrome before any data arrives', () => {
    // react-dom/server runs the component body without effects, which is the one
    // thing verifiable outside a browser: the tab must survive having no data.
    const html = renderToString(createElement(MemoryPendingTab, {}))
    assert.match(html, /记忆待审/)
    assert.match(html, /刷新/)
  })

  it('shows the session hint when the host supplies one', () => {
    const html = renderToString(createElement(MemoryPendingTab, { scope: { sessionId: 'sess-abcdef12' } }))
    // Server rendering inserts `<!-- -->` between text nodes, so assert on the
    // pieces rather than the joined sentence.
    assert.match(html, /会话/)
    assert.match(html, /sess-abc/)
  })

  it('is a no-op on a client without the sidebar service', () => {
    assert.doesNotThrow(() => { apply({}) })
    assert.doesNotThrow(() => { apply({ get: () => undefined }) })
  })

  it('registers one tab and disposes it with the context', () => {
    const tabs: Array<{ id: string; title: string; order?: number; component: unknown }> = []
    let disposed = false
    const effects: Array<() => void> = []
    apply({
      get: (key: string) => key === 'betterSidebar'
        ? {
            registerTab: (tab: { id: string; title: string; order?: number; component: unknown }) => {
              tabs.push(tab)
              return () => { disposed = true }
            },
          }
        : undefined,
      effect: (register: () => () => void) => { effects.push(register()) },
    })

    assert.equal(tabs.length, 1)
    assert.equal(tabs[0]?.id, 'dsh-memory:pending')
    assert.equal(tabs[0]?.title, '记忆待审')
    assert.equal(typeof tabs[0]?.component, 'function')

    for (const dispose of effects) dispose()
    assert.equal(disposed, true, 'the tab must not outlive its context')
  })
})
