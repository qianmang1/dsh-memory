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
    // are baseline externals the shell seeds into the module table.
    deps: { neverBundle: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/cordis'] },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-memory", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
