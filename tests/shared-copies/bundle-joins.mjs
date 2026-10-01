// Bundled with its ripple-di copy, which joins an implementation preloaded by
// the process from an external copy.
import assert from "node:assert/strict"

import * as bundled from "ripple-di"

const library = await import(new URL("./lib/index.mjs", import.meta.url).href)

assert.equal(bundled.MissingProviderError, library.ripple.MissingProviderError)
const useDouble = library.ripple.defineDependency(() => library.useBase() * 2)
assert.equal(
  await bundled.withOverrides(library.ripple.provide(library.useBase, 3), () =>
    useDouble(),
  ),
  6,
)
