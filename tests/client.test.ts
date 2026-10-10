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
    const html = renderToString(createElement(MemoryPendingTab, { injected: { sessionId: 'sess-abcdef12' } }))
    assert.match(html, /记忆待审/)
    assert.match(html, /刷新/)
  })

  it('keeps the session id out of the visible chrome', () => {
    // The session id is plumbing (it arrives via the pane inject callback);
    // showing a raw `sess-…` value confused readers, so the chrome no longer
    // prints it.
    const html = renderToString(createElement(MemoryPendingTab, { injected: { sessionId: 'sess-abcdef12' } }))
    assert.doesNotMatch(html, /sess-abc/)
  })

  it('renders without an injected session', () => {
    // The pane hands down the Session id through the inject callback; a body
    // that misses it must still render the queue chrome.
    const html = renderToString(createElement(MemoryPendingTab, {}))
    assert.match(html, /记忆待审/)
    assert.doesNotMatch(html, /sess-abc/)
  })

  it('is a no-op on a client without the native sidebar services', () => {
    // With `inject = ['slots', 'sidebarRightTabs']` a real host would never
    // call apply in this situation; the guard is defense-in-depth for
    // hand-rolled callers.
    assert.doesNotThrow(() => { apply({} as never) })
  })

  it('registers the tab type and the keyed pane slot', () => {
    const tabs: Array<{ id: string; kind: string }> = []
    const slotRegisters: Array<{ name: string; key?: string }> = []
    const slotInjects: Array<{ name: string }> = []
    const effects: Array<() => void> = []
    let disposed = false
    apply({
      sidebarRightTabs: {
        register: (definition: { id: string; kind: string }) => {
          tabs.push(definition)
          return () => { disposed = true }
        },
      },
      slots: {
        inject: (name: string, factory: () => unknown) => {
          slotInjects.push({ name })
          factory()
        },
        register: (options: { name: string; key?: string }) => {
          slotRegisters.push(options)
          return () => {}
        },
      },
      effect: (register: () => () => void) => { effects.push(register()) },
    } as never)

    assert.equal(tabs.length, 1)
    assert.equal(tabs[0]?.id, 'dsh-memory')
    assert.equal(tabs[0]?.kind, 'dsh-memory-pending')

    // The body rides the first-party pane seat, keyed by the definition id.
    assert.equal(slotInjects.length, 1)
    assert.equal(slotInjects[0]?.name, 'sidebar.right.pane.tab')
    assert.equal(slotRegisters.length, 1)
    assert.equal(slotRegisters[0]?.name, 'sidebar.right.pane.tab')
    assert.equal(slotRegisters[0]?.key, 'dsh-memory')

    for (const dispose of effects) dispose()
    assert.equal(disposed, true, 'the tab must not outlive its context')
  })
})
