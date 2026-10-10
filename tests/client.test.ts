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
    // `scope` is required by the sidebar's own TabComponentProps, so the fixture
    // supplies the host-shaped value rather than an empty object.
    const html = renderToString(createElement(MemoryPendingTab, { scope: { sessionId: 'sess-abcdef12' } }))
    assert.match(html, /记忆待审/)
    assert.match(html, /刷新/)
  })

  it('shows which session the queue belongs to', () => {
    const html = renderToString(createElement(MemoryPendingTab, { scope: { sessionId: 'sess-abcdef12' } }))
    // Server rendering inserts `<!-- -->` between text nodes, so assert on the
    // pieces rather than the joined sentence.
    assert.match(html, /会话/)
    assert.match(html, /sess-abc/)
  })

  it('ignores the scope fields it does not render', () => {
    // SessionScope carries cwd/repoRoot as well; a tab that only reads sessionId
    // must stay indifferent to them.
    const html = renderToString(createElement(MemoryPendingTab, {
      scope: { sessionId: 'sess-abcdef12', cwd: 'D:\\DSH_work', repoRoot: 'D:\\DSH_work' },
    }))
    assert.match(html, /记忆待审/)
    assert.doesNotMatch(html, /DSH_work/)
  })

  it('is a no-op on a client without the sidebar service', () => {
    // With `inject = ['betterSidebar']` a real host would never call apply in
    // this situation; the guard is defense-in-depth for hand-rolled callers.
    assert.doesNotThrow(() => { apply({}) })
    assert.doesNotThrow(() => { apply({ betterSidebar: undefined as never }) })
  })

  it('registers one tab and disposes it with the context', () => {
    // TabDescriptor.title may be a string or a lazy () => string; the fixture
    // records whichever shape arrives.
    const tabs: Array<{ id: string; title: string | (() => string); order?: number; component: unknown }> = []
    let disposed = false
    const effects: Array<() => void> = []
    apply({
      // apply reads the service off the context: inject guarantees presence,
      // the fixture plays the host that has already provided it.
      betterSidebar: {
        registerTab: (tab: { id: string; title: string | (() => string); order?: number; component: unknown }) => {
          tabs.push(tab)
          return () => { disposed = true }
        },
      },
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
