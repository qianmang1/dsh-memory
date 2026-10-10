/**
 * Light test stub for `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * Tests never load the real package: its lib imports `*.module.css` and has
 * undeclared runtime deps (a 0.2.0-rc.2 packaging gap the host's vite pipeline
 * papers over). This stub keeps the renderToString checks about OUR tab —
 * chrome, states, decision flow — while TypeScript still type-checks against
 * the real package (devDependency `@deepseek-ai/dsh-client-ui-primitives`),
 * so prop drift fails `pnpm typecheck`.
 */
import { createElement } from 'react'

export const Button = (props) =>
  createElement('button', {
    type: props.type,
    disabled: props.disabled,
    onClick: props.onClick,
  }, props.children)

export const Tag = (props) => createElement('span', { 'data-tone': props.tone }, props.children)

export function SegmentedTabs() {
  return null
}

export const TextShimmer = (props) => (props.active === false ? null : props.children)
