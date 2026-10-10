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
  // Host half: one entry per toggleable component plus the inert root-row
  // portal (see src/portal.ts for why the bare `dsh-memory` row must exist).
  // clean stays off: lib/ also holds the client artifact from the second
  // config, and a clean here would silently delete it (observed 2026-10-10).
  {
    name: 'host',
    entry: {
      index: 'src/index.ts',
      'core-plugin': 'src/core-plugin.ts',
      recall: 'src/recall-plugin.ts',
      capture: 'src/capture-plugin.ts',
      review: 'src/review-plugin.ts',
      'debug-plugin': 'src/debug-plugin.ts',
      portal: 'src/portal.ts',
    },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    external: [...builtinModules, ...builtinModules.map((name) => `node:${name}`), ...DSH_EXTERNALS],
  },
  // Client half: only the sidebar tab.
  //
  // The host never runs this artifact as a module. It concatenates the bundle
  // bytes into a combo script and injects them with a CLASSIC <script> tag, and
  // the artifact calls window.__ModuleLoader__.load({id, factory}) — so the
  // format must be cjs (the factory receives `require`, and baseline externals
  // like react resolve through it), plus the banner/footer/intro below. An ESM
  // build is a hard SyntaxError in the browser: measured, it killed the whole
  // web boot ("web boot: 1 entry did not activate").
  //
  // The official client preset (deepseek-harness packages/client/tsdown.client.ts,
  // banner/footer/intro at its lines 616-622) emits exactly this wrapper. A
  // third-party repo cannot import that workspace module, so the protocol is
  // restated here rather than invented differently.
  {
    name: 'client',
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
    // React must resolve to the host's copy: a bundled second instance would make
    // every hook in this tab throw "invalid hook call". React and its JSX runtime
    // are baseline externals the shell seeds into the module table, as is the
    // official primitives package (dsh-better-sidebar requires it the same way).
    deps: {
      neverBundle: [
        'react',
        'react-dom',
        'react/jsx-runtime',
        '@deepseek-ai/cordis',
        '@deepseek-ai/dsh-client-ui-primitives',
      ],
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-memory", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
