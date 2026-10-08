import { builtinModules } from 'node:module'
import { defineConfig } from 'tsdown'

// The dsh runtime packages this plugin imports are provided by the user's dsh
// install at load time; a published bundle resolves them through Node's upward
// search from its installed location (the profile's node_modules), so they stay
// external instead of being bundled.
const DSH_EXTERNALS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-tools',
]

export default defineConfig([
  // Host half: the plugin row the bundle patch mounts.
  {
    name: 'host',
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: true,
    external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`), ...DSH_EXTERNALS],
  },
  // Client half: only the sidebar tab. React comes from the host's client
  // runtime, so it stays external rather than being duplicated in the bundle.
  {
    name: 'client',
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'browser',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
    // React must resolve to the host's copy: a bundled second instance would make
    // every hook in this tab throw "invalid hook call" in the real sidebar. The
    // JSX runtime is listed too — otherwise its implementation is inlined while
    // the hooks come from the host, which is exactly the mismatch to avoid.
    deps: { neverBundle: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/cordis'] },
  },
])
