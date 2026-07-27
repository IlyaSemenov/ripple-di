// Checks the built package on every runtime the README claims support for.
// Run it after `bun run build` with node, deno, or bun.
import assert from "node:assert/strict"

import {
  AsyncFactoryError,
  asValue,
  createOverrideRunner,
  createRuntime,
  createScope,
  defineDependency,
  dispose,
  install,
  MissingProviderError,
  provide,
  ScopeClosedError,
  withOverrides,
} from "../dist/index.mjs"

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

const closed = []
const useConfig = defineDependency(() => ({ url: "production" }))
const useDb = defineDependency(() => ({ url: useConfig().url }), {
  dispose: (db) => {
    closed.push(db.url)
  },
})

assert.equal(useDb().url, "production")

// Overrides survive an async context switch and stay isolated in parallel.
const scopedUrl = await withOverrides(
  [provide(useConfig, { url: "scoped" })],
  async () => {
    await delay(1)
    return useDb().url
  },
)
assert.equal(scopedUrl, "scoped")
assert.equal(useDb().url, "production")

const [leftUrl, rightUrl] = await Promise.all([
  withOverrides([provide(useConfig, { url: "left" })], async () => {
    await delay(5)
    return useDb().url
  }),
  withOverrides([provide(useConfig, { url: "right" })], () => useDb().url),
])
assert.deepEqual([leftUrl, rightUrl], ["left", "right"])

const useTenant = defineDependency()
const installation = install([provide(useTenant, "acme")])
assert.equal(useTenant(), "acme")
await installation.close()
assert.throws(() => useTenant(), MissingProviderError)

const useSession = defineDependency()
const useRegion = defineDependency()
let sessionCount = 0
const sessionOverrides = createOverrideRunner(() => [
  provide(useSession, `session-${++sessionCount}`),
])
const regionOverrides = sessionOverrides.extend(() => [
  provide(useRegion, "eu"),
])
assert.equal(await sessionOverrides.run(() => useSession()), "session-1")
assert.equal(
  await regionOverrides.run(() => `${useSession()}/${useRegion()}`),
  "session-2/eu",
)

const scope = createScope([provide(useConfig, { url: "manual" })])
assert.equal(
  scope.run(() => useDb().url),
  "manual",
)
await scope.close()
assert.deepEqual([...closed].sort(), ["left", "manual", "right", "scoped"])

// Promise detection depends on the host runtime's native promise.
const useAsyncFactory = defineDependency(async () => "value")
assert.throws(() => useAsyncFactory(), AsyncFactoryError)
const useToken = defineDependency(() => asValue(Promise.resolve("token")))
assert.equal(await useToken(), "token")

// An awaitable value such as a query builder stays the value itself.
const useQueryBuilder = defineDependency(() => ({
  url: "builder",
  // biome-ignore lint/suspicious/noThenProperty: the awaitable value is the subject under test.
  then: (onfulfilled) => Promise.resolve(["rows"]).then(onfulfilled),
}))
const queryBuilder = useQueryBuilder()
assert.equal(queryBuilder.url, "builder")
assert.equal(useQueryBuilder(), queryBuilder)
assert.deepEqual(await queryBuilder, ["rows"])

// The README example for several independent runtimes.
function createApplication(databaseUrl) {
  const runtime = createRuntime()
  const useApplicationConfig = runtime.defineDependency(() => ({ databaseUrl }))
  const useApplicationDb = runtime.defineDependency(() => {
    const { databaseUrl: url } = useApplicationConfig()
    return { url, query: async () => `rows from ${url}` }
  })
  return { runtime, useDb: useApplicationDb }
}

const production = createApplication("production-db")
const preview = createApplication("preview-db")
assert.equal(await production.useDb().query(), "rows from production-db")
assert.equal(await preview.useDb().query(), "rows from preview-db")
await Promise.all([production.runtime.dispose(), preview.runtime.dispose()])

await dispose()
assert.throws(() => useDb(), ScopeClosedError)

const runtimeName = globalThis.Bun
  ? `bun ${globalThis.Bun.version}`
  : globalThis.Deno
    ? `deno ${globalThis.Deno.version.deno}`
    : `node ${globalThis.process.version}`
console.log(`ripple-di smoke test passed on ${runtimeName}`)
