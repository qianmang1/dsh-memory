import { default as main } from './tsdown.config.ts'

// Client-only build for the dev loop: `pnpm dev:client` watches just the
// sidebar bundle, so saving src/client/** rewrites lib/client.js within the
// source tree. With the web profile's node_modules/dsh-memory junctioned to
// this repo, the served bundle changes on disk and the page hot-swaps via the
// HMR transport — no re-add, no page reload.
const client = main.find((config) => config.name === 'client')

export default client
