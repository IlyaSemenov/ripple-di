# Ripple DI

**Next-generation dependency injection for TypeScript.**

Override a dependency for one request, test, or job.
Ripple DI automatically gives everything that uses it the right scoped version, reuses everything else, and cleans up temporary resources when the work is done.

No required decorators, reflection metadata, string tokens, or container object in application code.

## Example

Define a database from configuration and use it as a normal imported function:

```ts
import { defineDependency } from "ripple-di"

export const useConfig = defineDependency(() => ({
  databaseUrl: process.env.DATABASE_URL,
}))

export const useDb = defineDependency(
  () => createDb(useConfig().databaseUrl),
  { dispose: db => db.close() },
)

export async function loadUsers() {
  return useDb().query("select * from users")
}
```

Now replace only the configuration for one operation:

```ts
import { provide, withOverrides } from "ripple-di"

const users = await withOverrides(
  provide(useConfig, { databaseUrl: testDatabaseUrl }),
  () => loadUsers(),
)
```

`useDb` reads `useConfig()`, so Ripple DI builds a separate database for the test configuration and loads the users through it.
The production database and everything unrelated keep the instances they already had, and the temporary database is closed when the callback finishes.

This is the ripple: override one input, and only the values derived from it are rebuilt.

## Design trade-off

Ripple DI is an ambient service locator by design: code imports a dependency and calls it instead of receiving it as an argument.

This makes dependencies convenient to use and override, but also makes them less explicit: looking at a function's signature does not tell you which Ripple DI dependencies it reads.

## Install

```sh
npm install ripple-di
```

Ripple DI needs `node:async_hooks` and explicit resource management symbols, so it runs on Node.js 18.18 or newer, Bun, and Deno with Node compatibility, but not in browsers.
The package is published as ESM.

## Which function do I call?

| You want to                                   | Call
| --------------------------------------------- | --------------------------------------------------
| Define an input, derived value, or service    | `defineDependency`
| Define an overrideable factory                | `defineFactoryDependency`
| Supply the application's values at startup    | `install` with `provide` or `provideFactory`
| Collect provisions from several modules       | `collectProvisions`
| Replace values for one callback               | `withOverrides` with `provide` or `provideFactory`
| Memoize a getter or zero-argument method      | `@memo`
| Keep one scope open across several operations | `createScope`
| Continue every current override layer         | `withDetachedContext`
| Run detached with selected overrides          | `withDetachedOverrides`
| Shut everything down                          | `dispose`

`createValueOverride` and `createOverrideRunner` in [Advanced usage](#advanced-usage) turn overrides you write repeatedly into reusable helpers.

## Define dependencies

Define each shared input and service once, in the module that owns it, and import it wherever it is used.

Call `defineDependency<T>()` without a factory when a value must come from the application, request, or task boundary.

```ts
import { defineDependency, provide, withOverrides } from "ripple-di"

const useTenant = defineDependency<Tenant>()

await withOverrides(
  provide(useTenant, tenant),
  () => processRequest(),
)
```

Reading it without a provider throws `MissingProviderError`.

Pass a factory when the dependency has a built-in value.
The factory runs lazily, and calls to other dependencies inside it are tracked.

A function passed first is always the dependency factory, so wrap a function value in another function (`defineDependency(() => handler)`) or use [`defineFactoryDependency`](#define-factory-dependencies) to call it directly with runtime arguments.

```ts
const useClock = defineDependency(() => systemClock)
const usePublicUrl = defineDependency(() => createPublicUrl(useConfig()))
```

The result is cached, and a scope that overrides one of the dependencies it read gets a separate result.
Its type comes from the factory, so `useDb()` returns whatever `createDb` returns.

Configure `dispose` when values owned by Ripple DI need cleanup.
Pass a callback, or pass `true` to use the value's standard disposal method (`Symbol.asyncDispose` or `Symbol.dispose`).

A factory can read dependencies, but cannot create, enter, close, or retire scopes and installations in its own runtime; misuse throws `FactoryScopeOperationError`.

A dependency factory returns synchronously; see [Promises and thenables](#promises-and-thenables) when the value itself is asynchronous.

## Override dependencies

`withOverrides` runs a callback with temporary values and cleans up whatever it created for that callback.
Pass one `provide` or `provideFactory` directly.

```ts
import { provide, withOverrides } from "ripple-di"

const users = await withOverrides(
  provide(useConfig, {
    databaseUrl: "postgres://localhost/test",
  }),
  () => loadUsers(),
)
```

Inside the callback `useConfig()` returns the test configuration, and `useDb()` returns a database built from it.
The production database is untouched.

Override as many dependencies as you need in one call.

```ts
await withOverrides(
  [
    provide(useConfig, testConfig),
    provide(useClock, fixedClock),
  ],
  () => generateReport(),
)
```

Overrides survive `await` and stay isolated between parallel callbacks.

```ts
const [leftUsers, rightUsers] = await Promise.all([
  withOverrides(provide(useConfig, leftConfig), () => loadUsers()),
  withOverrides(provide(useConfig, rightConfig), () => loadUsers()),
])
```

### Awaitable callback results

`withOverrides`, and every helper built on it, awaits what its callback returns before closing the temporary scope, so returning a query builder from one of them runs the query.
Use such a value inside the callback, and use `createScope` when it has to outlive the callback.

Wrapping the value in an object prevents it from being awaited, but the temporary scope still closes before the caller receives it.
Anything that scope owned has already been cleaned up.

Use [detached context](#continue-after-the-current-scope-closes) when work must continue after the current scope closes.

## Where a value belongs

The same tracked dependency calls that decide when a factory result must be rebuilt also decide which lifecycle owns it and invokes its disposer.
A factory-created value belongs to the innermost scope that supplied either its factory or one of the dependencies it read.
When its factory and everything it read belong to the application, the value belongs to the application too, and closing a child scope leaves it alone.

**Reading a dependency inside a scope does not make its value scope-local.**

```ts
// Wrong: every request shares this one transaction.
const useTransaction = defineDependency(
  () => useDb().transaction(),
  { dispose: tx => tx.rollback() },
)
```

`useDb` belongs to the application, so a transaction built from it belongs to the application too.
Every request reads the same transaction, and it is rolled back at shutdown rather than when the request ends.

For a value that belongs to one operation, define the dependency without a built-in factory.
Provide its factory when you create the scope of that operation:

```ts
const useTransaction = defineDependency<Transaction>({
  dispose: tx => tx.rollback(),
})

await withOverrides(
  provideFactory(useTransaction, () => useDb().transaction()),
  () => processRequest(),
)
```

Each call now builds its own transaction, still lazily, and the scope rolls it back when the callback finishes.
Reading `useTransaction()` outside such a scope throws `MissingProviderError` instead of quietly sharing one.

A value also becomes scope-local through what it reads: a factory that reads a dependency the scope provides — a request context, a tenant, a fixed clock — is rebuilt in that scope and cleaned up with it.

An installation follows the same rule: a value belongs to it when the installation supplied its factory or one of the dependencies the factory read.

```ts
const useBuiltInConfig = defineDependency(() => rootConfig)
const useRootPool = defineDependency(() => createPool(useBuiltInConfig()), {
  dispose: pool => pool.end(),
})

const useInstalledConfig = defineDependency<DatabaseConfig>()
const useInstalledPool = defineDependency(() => createPool(useInstalledConfig()), {
  dispose: pool => pool.end(),
})

const installation = install(provide(useInstalledConfig, installedConfig))
useRootPool()
useInstalledPool()
await installation.close() // Before installing replacement providers.
```

The installed pool closes with the installation, while the root pool remains cached until `dispose()` because its factory read only built-in dependencies.

## Wire the application at startup

Some dependencies get their real value only when the application starts.
`install` supplies them once for the whole process.

```ts
// dependencies.ts
import { defineDependency } from "ripple-di"

export const useWebConfig = defineDependency<WebConfig>()
export const useTenantResolver = defineDependency<TenantResolver>()
```

```ts
// startup.ts
import { dispose, install, provide } from "ripple-di"

import { useTenantResolver, useWebConfig } from "./dependencies"

install([
  provide(useWebConfig, config),
  provide(useTenantResolver, resolveTenant),
])

try {
  await runApplication()
} finally {
  await dispose()
}
```

Installed providers are the fallback everywhere: request handlers, background jobs, tests, and any other code running outside a scope.
Nothing is resolved eagerly, and a scoped override still wins over an installed provider.

Closing an installation removes its providers and cleans up values whose factory or tracked dependencies belong to it.
It keeps the runtime usable, so application-owned values remain cached for later installations.
Use `installation.close()` before a controlled replacement; use `dispose()` to shut the application down.

- Installing while another installation or any scope is still open throws `InstallationConflictError`, whose message says what is still open.
  Await `installation.close()` before installing a replacement.
- Providing the same dependency twice in one installation is rejected, exactly like in `withOverrides`.
- Install once during startup.
  Late installation is supported for a controlled bootstrap or a test setup: it applies to the reads that come after it, and closing it brings the earlier values back.
- If a resource needs the lifetime of each installation, define its dependency without a built-in factory and export a module provision builder that returns `provideFactory`.
  This keeps the factory body in its owning module, but removes the built-in fallback: reading the dependency without that provision throws `MissingProviderError`.
- Every worker thread and every process wires its own installation.
- In tests, install once for the whole process and override per test, as shown in [Test your application](#test-your-application).

### Collect the providers of several modules

One runtime has one installation, so independent modules cannot each install their own providers.
A module exports the provisions it owns, and the composition root installs them together.

```ts
// core/providers.ts
export function getCoreProvisions() {
  return [
    provide(useDbConfig, dbConfig),
    provide(useEmailTransport, emailTransport),
  ]
}
```

```ts
// platform/providers.ts
export function getPlatformProvisions() {
  return [
    provide(useAgentChatConfig, agentChatConfig),
  ]
}
```

```ts
// startup.ts
import { dispose, install } from "ripple-di"

install(
  getCoreProvisions(),
  platformEnabled && getPlatformProvisions(),
)

onShutdown(() => dispose())
```

`install` accepts individual provisions and provision lists, flattens each list one level, and omits `false`, `null`, and `undefined` arguments.
This keeps conditional module wiring explicit without temporary arrays or repeated spread syntax.

Use `collectProvisions` with the same arguments when provisions need to be combined and passed or returned before installation.

- Export a function that builds the provisions rather than a ready-made array, so each installation gets provisions of its own.
  A provision that hands over ownership belongs to a single installation and cannot be reused by the next one.
- The composition root that installs the provisions also calls `dispose()` from the shutdown hook the application already has.
- Tests have the same single composition root: one preload installs the provisions of every layer the suite needs.
  Separate preloads installing on their own would fail on the second `install` instead of adding their providers.

## Application shutdown

Call `dispose()` when the application shuts down.
It closes every scope and cleans up every owned value still held by the module-level API, including an active installation.
Closing only the installation can leave [application-owned values](#where-a-value-belongs) cached.

```ts
import { dispose } from "ripple-di"

await dispose()
```

Values created inside `withOverrides` never wait for shutdown; they are cleaned up when their own callback finishes.

`dispose()` is final: afterwards the runtime cannot resolve dependencies, create scopes, or install providers, and those calls throw `ScopeClosedError`.
Do not use it to reset state between tests — use `withOverrides` for that, or create a separate runtime for each lifecycle.

## Test your application

Install the wiring the suite needs once for the whole test process, from the preload or setup file the test runner already has, and give each test the values of its own.

```ts
import {
  createOverrideRunner,
  createScope,
  provide,
  type Scope,
  withOverrides,
} from "ripple-di"

test("loads users from the test database", () =>
  withOverrides(
    provide(useConfig, testConfig),
    () => loadUsers(),
  ),
)
```

The scope lives exactly as long as that callback, so tests running in parallel cannot see one another's overrides.

When several tests share one set of values that is expensive to build, create the scope once and run each test inside it.

```ts
let scope: Scope

beforeAll(() => {
  scope = createScope(provide(useConfig, testConfig))
})

afterAll(() => scope.close())

test("lists users", () => scope.run(() => listUsers()))
test("creates a user", () => scope.run(() => createUser()))
```

Entering a scope in a hook does not carry it into the tests that follow.

```ts
// Wrong: the scope is current inside this callback and nowhere else.
beforeAll(() => scope.run(() => {}))
```

- `scope.run` and `withOverrides` make a scope current for their own callback only, so every test that needs the scope runs inside one of them.
- Tests that share a suite scope also share the values cached in it, so keep that recipe for values they can safely reuse.
- `scope.run` does not report child scopes a test leaves open, so a test that creates one closes it itself instead of leaving it until `afterAll`.

When every test in a file needs the same overrides in a separate scope, a runner applies them to each test independently.

```ts
const testConfigOverrides = createOverrideRunner(() =>
  provide(useConfig, testConfig),
)

test("lists users", testConfigOverrides.wrap(() => listUsers()))
test("creates a user", testConfigOverrides.wrap(() => createUser()))
```

## Advanced usage

Everything below is optional.

### Define factory dependencies

Use `defineFactoryDependency` when the dependency value is itself a factory that application code calls with runtime arguments.

Call `defineFactoryDependency<TFactory>()` without a factory when it must come from the application, request, or task boundary.

```ts
type SendEmail = (message: EmailMessage) => Promise<void>

const sendEmail = defineFactoryDependency<SendEmail>()
```

Calling it without a provider throws `MissingProviderError`.

Pass a factory when the dependency has a built-in value.

```ts
import { defineFactoryDependency } from "ripple-di"

const useLog = defineFactoryDependency(
  (area: string) =>
    (...values: unknown[]) => console.log(`[${area}]`, ...values),
)

const billingLog = useLog("billing")
billingLog("invoice created", 42)
```

Each call resolves the factory selected for the current scope and invokes it with the given arguments.
The arguments and result are ordinary program values.

`defineFactoryDependency` does not:

- Cache invocation results, whether by arguments or otherwise.
- Add runtime arguments or individual invocations to the dependency graph.
- Own or clean up invocation results.
- Create scopes for the objects it returns.

Replace the factory itself with `provide`.

```ts
const messages: unknown[][] = []

await withOverrides(
  provide(
    useLog,
    area => (...values) => messages.push([area, ...values]),
  ),
  () => useLog("billing")("invoice created", 42),
)
```

Calls made by the selected factory participate in a dependency factory that is already being evaluated.
For example, when `useView` calls `useLog("billing")` and that factory reads `useConfig()`, `useView` tracks both `useLog` and `useConfig` directly.
A direct `useLog("billing")` call has no lasting dependency graph entry, but every dependency it reads still resolves from the current scope.

`resolve(useLog)` and `scope.resolve(useLog)` return the selected factory without invoking it.
Use `provideFactory(useLog, () => factory)` only when constructing the factory value itself must be lazy and tracked.

### Promises and thenables

A factory returns the value itself, synchronously; disposers may be asynchronous.

```ts
import { asValue, defineDependency } from "ripple-di"

// The usual case: the factory returns the value.
defineDependency(() => createSessionStore())

// Reading this throws AsyncFactoryError: reads made after an await are not tracked.
defineDependency(async () => loadSession())

// The promise itself is the cached dependency value.
defineDependency(() => asValue(loadSession()))

// A query builder implements `then` but is an ordinary value.
defineDependency(() => selectSessions())
```

A factory is rejected only when it returns a native `Promise` object, so a value that merely implements `then` is stored as it is.
Wrap the result in `asValue` when the promise itself is the value the dependency holds.

`asValue` marks the promise as the value and does nothing else.
The dependencies its asynchronous work reads after an `await` are still untracked, so a promise cached for the whole application can end up built from the temporary values of whichever scope started it.

### Choose how to provide a value

Each form of `provide` answers one question: who cleans the value up?
The cleanup configured by `defineDependency` describes how to clean up an owned value; it does not make a plain provided value owned.

```ts
// You own the value. Ripple DI uses it in the scope and never disposes it.
provide(useConfig, testConfig)

// The scope creates the value on first read, owns it, and cleans it up with
// the cleanup from the dependency definition.
provideFactory(useDb, () => createFakeDb())

// You hand an existing value over to the scope, cleaned up the same way.
provide(useDb, fakeDb, { dispose: true })

// Same handover, with cleanup you specify instead.
provide(useDb, fakeDb, { dispose: db => db.closeImmediately() })
```

A function passed to `provide` stays an ordinary function value; use `provideFactory` when it should build the value instead.
The dependencies an override factory reads are tracked like the ones read by the factory it replaces.
An override factory cannot read the previous value of the dependency it replaces; define a base dependency and a decorated one instead.

`dispose: true` in `provide` reuses the dependency's cleanup configuration, so it throws right away when the dependency declares none.
Plain provided values remain borrowed even when they implement either symbol.

A provision that hands over ownership belongs to a single scope or installation.
Using it a second time throws `OwnedProvisionReuseError`, so create a separate value for each owner.

A dependency can define a shared cleanup rule even when it has no built-in factory:

```ts
const useQueue = defineDependency<Queue>({
  dispose: queue => queue.close(),
})

install(provideFactory(useQueue, () => createQueue(queueUrl)))

// Later, at application shutdown:
await dispose()
```

The installed factory is lazy, and its queue client is closed either with the installation during a controlled replacement or with the runtime at application shutdown.

### Manage a scope explicitly

Use `withOverrides` when one callback covers the whole lifetime.
Use `createScope` when several operations share the same overrides and close at a boundary you manage yourself.
`Scope` implements `AsyncDisposable`, so TypeScript code can express that boundary with `await using`:

```ts
import { createScope, provide } from "ripple-di"

await using scope = createScope(provide(useConfig, tenantConfig))
await scope.run(() => processTenant())
```

`Installation` delegates the same protocol to `close()`, and `Runtime` delegates it to `dispose()`.

- `scope.run` makes the scope current for a callback without closing it, and returns the callback's result unchanged.
- `scope.resolve(useDb)` reads a dependency from that scope rather than the current one.
  A factory reads from its own scope only, so calling `scope.resolve` on a different scope inside one throws `CrossScopeResolutionError`.
- `scope.createScope` and `scope.withOverrides` create children of that scope instead of the current one.
- A child of the scope that `withOverrides` created must be closed before the callback returns, otherwise Ripple DI closes it and throws `LeakedChildScopeError`.
- `scope.close()` closes the scope and everything below it, while `scope.retire()` waits for child scopes to finish first.
- Closing disposes what the scope itself created; reused application values stay open.
- Cleanup continues past a failing disposer and reports every failure in one `AggregateError`.
- A disposer, and any async work it starts, cannot read dependencies or manage scopes and installations in the runtime being closed; misuse throws `DisposerContextError`.
  Put everything cleanup needs into the dependency value itself.

### Continue after the current scope closes

`withDetachedContext` and `withDetachedOverrides` run work outside the current ambient scope, so a request or another scoped operation can close while that work continues.

Use `withDetachedContext` to continue with every override layer that is active when you call it:

```ts
import { withDetachedContext } from "ripple-di"

const backgroundTask = withDetachedContext(() =>
  updateTenantSearchIndex(),
)

trackBackgroundTask(backgroundTask)
```

It reproduces those layers in new scopes without copying cached dependency values.
Borrowed values keep their identity, while factory provisions run again and their results belong to the new scopes.
If a layer owns an existing provided value, the call rejects with `DetachedContextOwnedProvisionError` because the value cannot belong to both contexts.

Use `withDetachedOverrides` when the work should receive only selected values, especially across a security-sensitive boundary:

```ts
import { provide, withDetachedOverrides } from "ripple-di"

const tenant = useTenant()

const backgroundTask = withDetachedOverrides(
  provide(useTenant, tenant),
  () => updateTenantSearchIndex(),
)

trackBackgroundTask(backgroundTask)
```

Both functions create scopes beneath the active installation, or beneath the runtime root when no installation is active.
Closing the installation or calling `dispose()` force-closes them, and an unfinished root child prevents `install()`.

The scope remains current while the callback runs and while Ripple DI awaits its result.
The returned promise settles after cleanup, so code that needs the detached context, including finalization, belongs inside the callback:

```ts
withDetachedContext(() =>
  runBackgroundTask().finally(finalizeBackgroundTask),
)
```

### Name an override you write repeatedly

When a dependency is replaced in only one place, keep `withOverrides` with one `provide` at the call site.
For repeated replacements, `createValueOverride` turns the pattern into a named helper.

```ts
import { createValueOverride } from "ripple-di"

const withOpenAiClient = createValueOverride(useOpenAiClient)

await withOpenAiClient(client, () => createTextEmbedding(text))
```

Each call supplies the value it is given to one callback, exactly like writing `withOverrides` with a single `provide` by hand.
Pass the ownership options once, and every call cleans its own value up.

```ts
const withConnection = createValueOverride(useConnection, { dispose: true })
```

### Reuse one set of overrides

A long-lived object such as an API caller or a job worker is created once, but every call through it has to run with the same overrides in a scope of its own.
`createOverrideRunner` prepares those overrides once and applies them to each call separately.

```ts
import { createOverrideRunner, provide } from "ripple-di"

const jobOverrides = createOverrideRunner(() =>
  provide(useJobContext, createJobContext(), { dispose: true }),
)

const worker = createWorker(job => jobOverrides.run(() => handleJob(job)))
```

Every `run` call creates a scope, applies the overrides to it, and closes it when the callback finishes, exactly like `withOverrides`.
Concurrent calls stay isolated, and everything a call created is gone once it returns, while application values built outside the call keep their identity.

The overrides come from a function because it runs again for every call.
A value it hands over with `dispose` therefore belongs to the call that created it rather than to the runner, and returning the same handover provision to a second call throws `OwnedProvisionReuseError`.

`wrap` turns a function into one that applies the overrides itself, so the worker above can take the handler directly:

```ts
const worker = createWorker(jobOverrides.wrap(handleJob))
```

The wrapped function keeps the arguments and the receiver it is called with, and returns a promise for its result.
It prepares nothing in advance: every call of it is one `run` call with a temporary scope of its own.
That also suits a file of independent test cases that share one set of overrides.

`extend` returns a runner with one more layer of overrides and leaves the runner it extends unchanged:

```ts
const tenantOverrides = jobOverrides.extend(() =>
  provide(useTenantResolver, tenantResolver),
)

await tenantOverrides.run(() => handleRequest())
```

A call through `tenantOverrides` applies both layers, and the added layer wins wherever the two provide the same dependency.

Use `createScope` instead when several operations share one set of values that stay alive until you close the scope.
A runner never keeps a scope open between calls: it is for repeated independent calls, not for one long-lived scope.

### Memoize an object member

Use `memo` when a getter or zero-argument method reads Ripple dependencies and its object can outlive the scope where it is accessed.

```ts
import { memo } from "ripple-di"

class ViewModel {
  @memo
  get formatter() {
    return createFormatter(useLocale())
  }
}
```

The object determines where the value is stored, without keeping that object alive.
The Ripple dependencies read by the getter determine whether the value is valid in the current scope: changing `useLocale` rebuilds it, while unrelated overrides do not.
Nested memos propagate their dependency reads, so changing a dependency of an inner memo also invalidates its outer consumers.

Each object and member keeps only its latest value.
Returning to an earlier dependency context after an incompatible override therefore computes the value again.

`memoize` provides the same behavior without decorator syntax.

```ts
const currentFormatter = memoize(() => createFormatter(useLocale()))
```

Memo computations are synchronous, do not accept arguments, and do not cache thrown errors or native `Promise` results.
Ripple DI does not own or dispose their results.

Only Ripple dependencies are tracked.
Ordinary mutable fields do not invalidate a memo, so this API is not a reactive object system.

### Multiple runtimes

Most applications never need this.
The module-level functions all work on one built-in runtime.
Create your own only when a single process has to host several independent graphs, each with its own definitions, cached values, and shutdown lifecycle.

```ts
import { createRuntime } from "ripple-di"

function createApplication(databaseUrl: string) {
  const runtime = createRuntime()

  const useConfig = runtime.defineDependency(() => ({ databaseUrl }))
  const useDb = runtime.defineDependency(
    () => createDb(useConfig().databaseUrl),
    { dispose: db => db.close() },
  )

  return { runtime, useDb }
}

const production = createApplication(productionDatabaseUrl)
const preview = createApplication(previewDatabaseUrl)

const productionUsers = await production.useDb().query("select * from users")
const previewUsers = await preview.useDb().query("select * from users")

await Promise.all([
  production.runtime.dispose(),
  preview.runtime.dispose(),
])
```

A dependency belongs to the runtime that defined it and cannot be read or overridden in another one.
The module-level `defineDependency` always defines a dependency of the built-in runtime, so an application factory like the one above defines every dependency it needs through its own runtime.

Pass `name` to `createRuntime` to see that name in error messages.
Every runtime has the same methods, and each has a module-level counterpart that targets the built-in runtime:

- `defineDependency`
- `defineFactoryDependency`
- `install`
- `resolve`
- `createScope`
- `withOverrides`
- `withDetachedContext`
- `withDetachedOverrides`
- `createValueOverride`
- `createOverrideRunner`
- `dispose`

In that list, `resolve` is the explicit form of reading a value: `runtime.resolve(useDb)` returns the same thing as `useDb()`.
Everything shown earlier is that same API applied to the built-in runtime, so an ordinary application never creates or passes a runtime around.

## Diagnostics

During resolution and lifecycle management, Ripple DI reports mistakes with specific errors: `MissingProviderError` for a dependency with no provider, `DependencyCycleError` for a cycle, and `AsyncFactoryError` for a factory that returned a native promise without `asValue`.

Errors thrown by your own factory arrive wrapped in `FactoryError` with the original cause.
A failed factory is not cached, so the next read tries again.

These errors name the dependencies involved.
An explicit `name` is always used when you provide one:

```ts
const useConfig = defineDependency(loadConfig, { name: "config" })
```

The name only affects messages.
Without an explicit name, Ripple DI uses a non-empty factory name or shows a generated name with the `defineDependency` call location, such as `dependency#21 (packages/core/src/openai/config.ts:36)`.
The location follows the runtime's stack and source maps, is captured once when the dependency is defined, and adds no work during resolution.

## Do not mix package copies

Two copies of Ripple DI, separately installed or bundled, each run their own graph and cannot be combined.
Do not pass dependencies or provisions between them, and do not call one copy's dependency inside a factory owned by the other.
Such a call is not detected: the dependency may resolve against its own copy instead of failing at the boundary.

Declare `ripple-di` as a peer dependency in any package that exports dependencies of its own.

## Caveats

- Only the dependency calls made while a factory runs are tracked.
  Everything else stays invisible: `process.env`, `Date.now()`, and any dependency called after the factory has returned.
- Read dependencies where you use them.
  A module-level `const db = useDb()` freezes one scope's value forever.
- When a factory catches an error from reading a dependency, its value is not shared: every scope that asks for it builds a new one.

## License

MIT
