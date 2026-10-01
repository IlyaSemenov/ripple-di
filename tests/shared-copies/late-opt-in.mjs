// A copy evaluated before the opt-in entry keeps its own implementation.
import assert from "node:assert/strict"

import { ripple as library, useBase } from "./lib/index.mjs"

await import("ripple-di/shared")
// The library's own opt-in cannot change a copy that is already evaluated.
await import("./lib/shared.mjs")
const app = await import("ripple-di")

assert.notEqual(app.defineDependency, library.defineDependency)
assert.throws(() => app.provide(useBase, 2), {
  name: "TypeError",
  message: /Load "ripple-di\/shared" before every copy/,
})
