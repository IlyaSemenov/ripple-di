// Enables sharing before the application copy and the library copy load.
import "ripple-di/shared"

import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"

import * as app from "ripple-di"

import { copyUrl, ripple as library, useBase } from "./lib/index.mjs"
// A second opt-in from a copy of the same version is accepted.
import "./lib/shared.mjs"

function checkOneImplementation() {
  assert.notEqual(copyUrl, import.meta.resolve("ripple-di"))
  assert.deepEqual(Object.keys(library), Object.keys(app))
  for (const name of Object.keys(app)) {
    assert.equal(library[name], app[name], name)
  }
}

// Dependencies of both copies form one graph that reuses unaffected values.
async function checkGraphAndOverrides() {
  const useDouble = app.defineDependency(() => ({ value: useBase() * 2 }))
  const useUnrelated = library.defineDependency(() => "unrelated")
  const total = library.memoize(() => useDouble().value + 1)
  const rootDouble = useDouble()

  assert.equal(total(), 3)
  assert.equal(
    await library.withOverrides(app.provide(useBase, 5), () => total()),
    11,
  )
  assert.equal(
    await app.withOverrides(library.provide(useUnrelated, "replaced"), () =>
      useDouble(),
    ),
    rootDouble,
  )
  assert.equal(
    await app.withOverrides(library.withoutProvider(useBase), () =>
      library.resolve(useUnrelated),
    ),
    "unrelated",
  )
}

async function checkAsyncIsolation() {
  const useDouble = library.defineDependency(() => useBase() * 2)
  const results = await Promise.all([
    app.withOverrides(library.provide(useBase, 2), async () => {
      await delay(20)
      return useDouble()
    }),
    library.withOverrides(app.provide(useBase, 7), async () => {
      await delay(5)
      return useDouble()
    }),
  ])
  assert.deepEqual(results, [4, 14])
}

async function checkOwnership() {
  const disposed = []
  const useResource = library.defineDependency({
    name: "resource",
    dispose: (resource) => {
      disposed.push(resource.id)
    },
  })

  await app.withOverrides(
    library.provideFactory(useResource, () => ({ id: "factory" })),
    () => [useResource(), useResource()],
  )
  const handover = app.provide(
    useResource,
    { id: "handover" },
    { dispose: true },
  )
  await library.withOverrides(handover, () => useResource())
  await app.withOverrides(
    library.provide(useResource, { id: "borrowed" }),
    () => useResource(),
  )
  assert.deepEqual(disposed, ["factory", "handover"])

  await assert.rejects(
    async () => library.withOverrides(handover, () => {}),
    app.OwnedProvisionReuseError,
  )
}

async function checkValuesAndErrors() {
  const useSession = app.defineDependency(() =>
    library.asValue(Promise.resolve("session")),
  )
  assert.equal(await useSession(), "session")

  const useUnmarked = app.defineDependency(() => Promise.resolve("session"))
  assert.throws(() => useUnmarked(), library.AsyncFactoryError)

  const useMissing = library.defineDependency({ name: "missing" })
  assert.throws(
    () => app.resolve(useMissing),
    (error) =>
      error instanceof library.MissingProviderError &&
      error instanceof app.RippleError,
  )
}

async function checkDetachedContext() {
  const useRequest = library.defineDependency({ name: "request" })
  const useGreeting = app.defineDependency(() => `hello ${useRequest()}`)

  let detached
  await library.withOverrides(app.provide(useRequest, "alice"), () => {
    detached = app.runDetached(async () => {
      await delay(5)
      return useGreeting()
    })
  })
  assert.equal(await detached, "hello alice")

  const stream = await app.withOverrides(
    library.provide(useRequest, "bob"),
    () =>
      library.createDetachedStream(async function* () {
        await delay(5)
        yield useGreeting()
      }),
  )
  const values = []
  for await (const value of stream) {
    values.push(value)
  }
  assert.deepEqual(values, ["hello bob"])
}

async function checkInstallation() {
  const useTenant = app.defineDependency({ name: "tenant" })
  const installation = library.install(app.provide(useTenant, "installed"))
  assert.equal(useTenant(), "installed")
  assert.throws(() => app.install(), library.InstallationConflictError)
  await installation.close()
  assert.throws(() => useTenant(), app.MissingProviderError)
}

async function checkExplicitRuntimes() {
  const left = app.createRuntime({ name: "left" })
  const right = library.createRuntime({ name: "right" })
  const useLeft = left.defineDependency(() => "left")

  assert.throws(
    () => right.resolve(useLeft),
    library.CrossRuntimeDependencyError,
  )
  assert.throws(() => left.resolve(useBase), app.CrossRuntimeDependencyError)
  await left.dispose()
  assert.equal(useBase(), 1)
  await right.dispose()
}

async function checkShutdown() {
  let disposed = 0
  const useConnection = app.defineDependency(() => ({ base: useBase() }), {
    dispose: () => {
      disposed++
    },
  })
  useConnection()
  await library.dispose()
  assert.equal(disposed, 1)
  assert.throws(() => useBase(), app.ScopeClosedError)
}

checkOneImplementation()
await checkGraphAndOverrides()
await checkAsyncIsolation()
await checkOwnership()
await checkValuesAndErrors()
await checkDetachedContext()
await checkInstallation()
await checkExplicitRuntimes()
await checkShutdown()
