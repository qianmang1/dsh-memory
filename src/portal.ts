/**
 * Inert root-row mount for the dsh-memory bundle.
 *
 * The web client-module scanner only recognizes loader rows whose name is a
 * bare package specifier: `exactPackageSpecifier` rejects anything with a
 * subpath (`dsh-memory/core` lands in the "permanently not a client row"
 * branch of `locatePkgJson`), silently. A bundle made purely of subpath
 * component rows therefore never contributes a client half to the browser
 * boot graph — observed 2026-10-10: 72 entries served, `dsh-memory` absent,
 * sidebar tab never registered.
 *
 * This module is what the package root (`exports "."`) resolves to. It mounts
 * nothing and configures nothing; the row named `dsh-memory` exists purely so
 * the scanner resolves the package root, reads its `dsh.client` declaration,
 * and pulls `lib/client.js` into the boot graph. The real components stay on
 * their subpath rows with their own switches.
 * @module dsh-memory/portal
 */

export const name = 'dsh-memory'

export function apply(): void {}
