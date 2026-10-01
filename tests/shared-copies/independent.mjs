// Without the opt-in entry, every copy keeps its own implementation.
import assert from "node:assert/strict"

const globalKeys = Reflect.ownKeys(globalThis)
const app = await import("ripple-di")
const { ripple: library, useBase } = await import("./lib/index.mjs")
assert.deepEqual(Reflect.ownKeys(globalThis), globalKeys)

for (const name of Object.keys(app)) {
  assert.notEqual(library[name], app[name], name)
}
assert.throws(() => app.provide(useBase, 2), {
  name: "TypeError",
  message: /Load "ripple-di\/shared" before every copy/,
})
assert.throws(
  () => app.resolve(app.defineDependency()),
  (error) =>
    error instanceof app.MissingProviderError &&
    !(error instanceof library.RippleError),
)
assert.equal(useBase(), 1)
