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

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
  external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`), ...DSH_EXTERNALS],
})
