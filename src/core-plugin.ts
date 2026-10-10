/**
 * Dedicated subpath entry for the memory-core component.
 *
 * The package-root specifier stays out of the patch so the plugin page can
 * show a plugin-level name ("记忆系统") distinct from this component's row
 * ("记忆核心") — the root entry and a subpath row can never share locale text.
 */
export * from './index.js'
