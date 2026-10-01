// Bundled with its ripple-di copy, enables sharing, and loads an external copy.
import "ripple-di/shared"

import assert from "node:assert/strict"

import * as bundled from "ripple-di"

const library = await import(new URL("./lib/index.mjs", import.meta.url).href)

assert.equal(library.ripple.defineDependency, bundled.defineDependency)
const useDouble = bundled.defineDependency(() => library.useBase() * 2)
assert.equal(
  await library.ripple.withOverrides(bundled.provide(library.useBase, 4), () =>
    useDouble(),
  ),
  8,
)
