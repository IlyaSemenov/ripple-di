// Checks the built package on every runtime the README claims support for.
// Run it after `bun run build` with node, deno, or bun.
import assert from "node:assert/strict"

import {
  AsyncFactoryError,
  asValue,
  collectProvisions,
  createDetachedStream,
  createOverrideRunner,
  createRuntime,
  createScope,
  createValueOverride,
  defineDependency,
  defineFactoryDependency,
  dispose,
  install,
  MissingProviderError,
  provide,
  runDetached,
  ScopeClosedError,
  withOverrides,
  withoutProvider,
} from "../dist/index.mjs"

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds))

// Shared by the groups that show which databases were built and closed.
const closedDatabases = []
const useConfig = defineDependency(() => ({ url: "production" }))
const useDb = defineDependency(
  () => ({
    url: useConfig().url,
    [Symbol.dispose]() {
      closedDatabases.push(this.url)
    },
  }),
  { dispose: true },
)

function checkAmbientRead() {
  assert.equal(useDb().url, "production")
}

// Overrides survive an async context switch and stay isolated in parallel.
async function checkScopedOverrides() {
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
}

// A factory dependency resolves its factory per scope but never caches calls.
async function checkFactoryDependency() {
  const Create = defineFactoryDependency((label) => ({ label }))

  assert.notEqual(Create("same"), Create("same"))
  await withOverrides(
    provide(Create, (label) => ({ label: `test:${label}` })),
    (scope) => {
      assert.deepEqual(Create("value"), { label: "test:value" })
      assert.equal(scope.resolve(Create)("resolved").label, "test:resolved")
    },
  )
}

// A single provision needs no array, in every API that takes provisions.
async function checkInstallation() {
  const useTenant = defineDependency()
  const useFeature = defineDependency()
  const featureProvisions = collectProvisions(
    false,
    [provide(useFeature, "enabled")],
    undefined,
  )
  const installation = install(
    provide(useTenant, "acme"),
    null,
    featureProvisions,
  )

  assert.equal(useTenant(), "acme")
  assert.equal(useFeature(), "enabled")
  await installation[Symbol.asyncDispose]()
  assert.throws(() => useTenant(), MissingProviderError)
}

async function checkOverrideRunner() {
  const useSession = defineDependency()
  const useRegion = defineDependency()
  let sessionCount = 0
  const sessions = createOverrideRunner(() =>
    provide(useSession, `session-${++sessionCount}`),
  )
  const regions = sessions.extend(() => provide(useRegion, "eu"))

  assert.equal(await sessions.run(() => useSession()), "session-1")
  assert.equal(
    await regions.run(() => `${useSession()}/${useRegion()}`),
    "session-2/eu",
  )
}

async function checkValueOverride() {
  const useClient = defineDependency()
  const withClient = createValueOverride(useClient)

  assert.equal(
    await withClient("client", async () => {
      await delay(1)
      return useClient()
    }),
    "client",
  )
  assert.throws(() => useClient(), MissingProviderError)
}

async function checkManualScope() {
  const scope = createScope(provide(useConfig, { url: "manual" }))

  assert.equal(
    scope.run(() => useDb().url),
    "manual",
  )
  await scope[Symbol.asyncDispose]()
}

// Every scope above owned the database built from its own configuration.
function checkOwnedValueCleanup() {
  assert.deepEqual([...closedDatabases].sort(), [
    "left",
    "manual",
    "right",
    "scoped",
  ])
}

// Promise detection depends on the host runtime's native promise.
async function checkPromiseHandling() {
  const useAsyncFactory = defineDependency(async () => "value")
  const useToken = defineDependency(() => asValue(Promise.resolve("token")))

  assert.throws(() => useAsyncFactory(), AsyncFactoryError)
  assert.equal(await useToken(), "token")
}

// An awaitable value such as a query builder stays the value itself.
async function checkAwaitableValue() {
  const useQueryBuilder = defineDependency(() => ({
    url: "builder",
    // biome-ignore lint/suspicious/noThenProperty: the awaitable value is the subject under test.
    then: (onfulfilled) => Promise.resolve(["rows"]).then(onfulfilled),
  }))
  const queryBuilder = useQueryBuilder()

  assert.equal(queryBuilder.url, "builder")
  assert.equal(useQueryBuilder(), queryBuilder)
  assert.deepEqual(await queryBuilder, ["rows"])
}

// The README example for several independent runtimes.
async function checkMultipleRuntimes() {
  function createApplication(databaseUrl) {
    const runtime = createRuntime()
    const useApplicationConfig = runtime.defineDependency(() => ({
      databaseUrl,
    }))
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
  await Promise.all([
    production.runtime[Symbol.asyncDispose](),
    preview.runtime.dispose(),
  ])
}

// A detached stream keeps the request's overrides for every read after the
// request scope has closed, and runDetached refuses a generator result.
async function checkDetached() {
  const stream = await withOverrides(
    provide(useConfig, { url: "detached" }),
    () =>
      createDetachedStream(async function* () {
        while (true) {
          yield useDb().url
        }
      }),
  )
  const reader = stream[Symbol.asyncIterator]()

  assert.equal((await reader.next()).value, "detached")
  assert.equal((await reader.next()).value, "detached")
  assert.ok(!closedDatabases.includes("detached"))
  await stream[Symbol.asyncDispose]()
  assert.ok(closedDatabases.includes("detached"))
  assert.equal(await runDetached(() => useDb().url), "production")
  await assert.rejects(
    runDetached(async function* () {}),
    TypeError,
  )
}

async function checkWithoutProvider() {
  await assert.rejects(
    withOverrides(withoutProvider(useConfig), () => useDb()),
    MissingProviderError,
  )
  assert.equal(useDb().url, "production")
}

async function checkShutdown() {
  await dispose()
  assert.throws(() => useDb(), ScopeClosedError)
}

checkAmbientRead()
await checkScopedOverrides()
await checkFactoryDependency()
await checkInstallation()
await checkOverrideRunner()
await checkValueOverride()
await checkManualScope()
checkOwnedValueCleanup()
await checkPromiseHandling()
await checkAwaitableValue()
await checkMultipleRuntimes()
await checkDetached()
await checkWithoutProvider()
await checkShutdown()

const runtimeName = globalThis.Bun
  ? `bun ${globalThis.Bun.version}`
  : globalThis.Deno
    ? `deno ${globalThis.Deno.version.deno}`
    : `node ${globalThis.process.version}`
console.log(`ripple-di smoke test passed on ${runtimeName}`)
