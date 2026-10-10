/**
 * Test-only module map: redirect `@deepseek-ai/dsh-client-ui-primitives` to
 * scripts/test-primitives-stub.mjs (see that file for why). Type checking is
 * unaffected — tsc resolves the real devDependency.
 */
import { registerHooks } from 'node:module'

const stubUrl = new URL('./test-primitives-stub.mjs', import.meta.url).href

registerHooks({
  resolve(specifier, context, next) {
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
      return { url: stubUrl, shortCircuit: true }
    }
    return next(specifier, context)
  },
})
