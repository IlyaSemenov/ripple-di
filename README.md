# Ripple DI

Scoped dependency injection for TypeScript without container lookups in application code.

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
  [provide(useConfig, { databaseUrl: testDatabaseUrl })],
  () => loadUsers(),
)
```

`useDb` reads `useConfig()`, so Ripple DI builds a separate database for the test configuration and loads the users through it.
The production database and everything unrelated keep the instances they already had, and the temporary database is closed when the callback finishes.

This is the ripple: override one input, and only the values built from it change.

## Install

```sh
npm install ripple-di
```

Ripple DI needs `node:async_hooks`, so it runs on Node.js 18 or newer, Bun, and Deno with Node compatibility, but not in browsers.
The package is published as ESM.

## Quick start

Define each shared input and service once, next to the code that owns it.
Factories are lazy: they run the first time something reads the value.

```ts
// config.ts
import { defineDependency } from "ripple-di"

export const useConfig = defineDependency(() => ({
  databaseUrl: process.env.DATABASE_URL,
}))
```

```ts
// db.ts
import { defineDependency } from "ripple-di"

import { useConfig } from "./config"

export const useDb = defineDependency(
  () => createDb(useConfig().databaseUrl),
  { dispose: db => db.close() },
)
```

Anything that needs the database imports it and calls it.

```ts
import { useDb } from "./db"

export async function loadUsers() {
  return useDb().query("select * from users")
}
```

The return type of `useDb()` is inferred from `createDb`.

## Which function do I call?

| You want to                                               | Call
| --------------------------------------------------------- | ---------------------------
| Define an input, derived value, or service                | `defineDependency`
| Supply the real values when the application starts        | `install`
| Replace values for one callback                           | `withOverrides`
| Name an override of one dependency you write often        | `createValueOverride`
| Replace the same values for many separate calls           | `createOverrideRunner`
| Replace values for a lifetime you manage yourself         | `createScope`
| Supply a value, or a factory, to `install` or an override | `provide`, `provideFactory`
| Shut everything down                                      | `dispose`

## Define dependencies

Call `defineDependency<T>()` without a factory when a value must come from the application, request, or task boundary.

```ts
import { defineDependency, provide, withOverrides } from "ripple-di"

const useTenant = defineDependency<Tenant>()

await withOverrides(
  [provide(useTenant, tenant)],
  () => processRequest(),
)
```

Reading it without a provider throws `MissingProviderError`.
Pass a factory when the dependency has a built-in value.
The factory runs lazily, and calls to other dependencies inside it are tracked.
A function is always taken as that factory, so a dependency whose own value is a function needs `defineDependency(() => handler)`.

```ts
const useClock = defineDependency(() => systemClock)
const usePublicUrl = defineDependency(() => createPublicUrl(useConfig()))
```

The result is cached and recreated wherever one of the dependencies it read is overridden.
Add a `dispose` callback when values owned by Ripple DI need cleanup, as shown by `useDb` in the quick start.

## Override dependencies

`withOverrides` runs a callback with temporary values and cleans up whatever it created for that callback.

```ts
import { provide, withOverrides } from "ripple-di"

const users = await withOverrides(
  [
    provide(useConfig, {
      databaseUrl: "postgres://localhost/test",
    }),
  ],
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

For one dependency, you can omit the array:

```ts
await withOverrides(
  provide(useConfig, testConfig),
  () => loadUsers(),
)
```

Overrides survive `await` and stay isolated between parallel callbacks.

```ts
const [leftUsers, rightUsers] = await Promise.all([
  withOverrides([provide(useConfig, leftConfig)], () => loadUsers()),
  withOverrides([provide(useConfig, rightConfig)], () => loadUsers()),
])
```

### Name an override you write repeatedly

When the same dependency is supplied the same way all over the application, `createValueOverride` turns that into one named helper.

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
import { install, provide } from "ripple-di"

import { useTenantResolver, useWebConfig } from "./dependencies"

const installation = install([
  provide(useWebConfig, config),
  provide(useTenantResolver, resolveTenant),
])

try {
  await runApplication()
} finally {
  await installation.close()
}
```

Installed providers are the fallback everywhere: request handlers, background jobs, tests, and any other code running outside a scope.
Nothing is resolved eagerly, and a scoped override still wins over an installed provider.
Closing the installation removes its providers and cleans up the scopes and owned values created beneath it.

- Installing while another installation or any scope is still open throws `InstallationConflictError`, whose message says what is still open.
  Await `installation.close()` before installing a replacement.
- Providing the same dependency twice in one installation is rejected, exactly like in `withOverrides`.
- Installing late is allowed: it applies to the reads that come after it, and closing it brings the earlier values back.
- Every worker thread and every process wires its own installation.
- In tests, install once for the whole process and use `withOverrides` per test.

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
const installation = install([
  ...getCoreProvisions(),
  ...getPlatformProvisions(),
])

onShutdown(() => installation.close())
```

- Export a function that builds the provisions rather than a ready-made array, so each installation gets provisions of its own.
  A provision that hands over ownership belongs to a single installation and cannot be reused by the next one.
- The composition root that installs the provisions is also the one that closes the installation, from whichever shutdown hook the application already has.
- Tests have the same single composition root: one preload installs the provisions of every layer the suite needs.
  Separate preloads installing on their own would fail on the second `install` instead of adding their providers.

## Application shutdown

Call `dispose()` when the application shuts down.
It closes every scope and cleans up every owned value still held by the module-level API, including an active installation.

```ts
import { dispose } from "ripple-di"

await dispose()
```

Values created inside `withOverrides` never wait for shutdown; they are cleaned up when their own callback finishes.

`dispose()` is final: afterwards the runtime cannot resolve dependencies, create scopes, or install providers, and those calls throw `ScopeClosedError`.
Do not use it to reset state between tests — use `withOverrides` for that, or create a separate runtime for each lifecycle.

## Advanced usage

Everything below is optional.

### Choose how to provide a value

Each form of `provide` answers one question: who cleans the value up?
The disposer configured by `defineDependency` describes how to clean up an owned value; it does not make a plain provided value owned.

```ts
// You own the value. Ripple DI uses it in the scope and never disposes it.
provide(useConfig, testConfig)

// The scope creates the value on first read, owns it, and cleans it up with
// the dispose callback from the dependency definition.
provideFactory(useDb, () => createFakeDb())

// You hand an existing value over to the scope, cleaned up the same way.
provide(useDb, fakeDb, { dispose: true })

// Same handover, with cleanup you specify instead.
provide(useDb, fakeDb, { dispose: db => db.closeImmediately() })
```

A function passed to `provide` stays an ordinary function value; use `provideFactory` when it should build the value instead.
The dependencies an override factory reads are tracked like the ones read by the factory it replaces.
`dispose: true` reuses the disposer from `defineDependency`, so it throws right away when the dependency declares none.

A provision that hands over ownership belongs to a single scope or installation.
Using it a second time throws `OwnedProvisionReuseError`, so create a separate value for each owner.

A dependency can define a shared cleanup rule even when it has no built-in factory:

```ts
const useQueue = defineDependency<Queue>({
  dispose: queue => queue.close(),
})

const installation = install([
  provideFactory(useQueue, () => createQueue(queueUrl)),
])

// Later, at shutdown:
await installation.close()
```

The installed factory is lazy, and its queue client is closed with the installation.

### Manage a scope explicitly

Use `withOverrides` when one callback covers the whole lifetime.
Use `createScope` when several operations share the same overrides and close at a boundary you manage yourself.

```ts
import { createScope, provide } from "ripple-di"

const scope = createScope([
  provide(useConfig, tenantConfig),
])

try {
  await scope.run(() => processTenant())
} finally {
  await scope.close()
}
```

- `scope.run` makes the scope current for a callback without closing it.
- `scope.resolve(useDb)` reads a dependency from that scope rather than the current one.
- `scope.createScope` and `scope.withOverrides` create children of that scope instead of the current one.
- A child of the scope that `withOverrides` created must be closed before the callback returns, otherwise Ripple DI closes it and throws `LeakedChildScopeError`.
- `scope.close()` closes the scope and everything below it, while `scope.retire()` waits for child scopes to finish first.
- Closing disposes what the scope itself created; reused application values stay open.
- Cleanup continues past a failing disposer and reports every failure in one `AggregateError`.

### Reuse one set of overrides

A long-lived object such as an API caller or a job worker is created once, but every call through it has to run with the same overrides in a scope of its own.
`createOverrideRunner` prepares those overrides once and applies them to each call separately.

```ts
import { createOverrideRunner, provide } from "ripple-di"

const jobOverrides = createOverrideRunner(() => [
  provide(useJobContext, createJobContext(), { dispose: true }),
])

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
const tenantOverrides = jobOverrides.extend(() => [
  provide(useTenantResolver, tenantResolver),
])

await tenantOverrides.run(() => handleRequest())
```

A call through `tenantOverrides` applies both layers, and the added layer wins wherever the two provide the same dependency.

Use `createScope` instead when several operations share one set of values that stay alive until you close the scope.
A runner never keeps a scope open between calls: it is for repeated independent calls, not for one long-lived scope.

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
Pass `name` to `createRuntime` to see that name in error messages.
Every runtime has the same methods, and each has a module-level counterpart that targets the built-in runtime:

- `defineDependency`
- `install`
- `resolve`
- `createScope`
- `withOverrides`
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
Pass `name` to give one a readable label instead of a generated one:

```ts
const useConfig = defineDependency(loadConfig, { name: "config" })
```

The name only affects messages.

## Limits

- Factories are synchronous; disposers may be asynchronous.
  A factory returns the value itself, so a value that implements `then`, such as a query builder or another awaitable client, is stored as it is.
  A factory is rejected only when it returns a native `Promise` object, because dependency reads made after an `await` are not tracked.
  When the promise is the value, wrap the result in `asValue`: `defineDependency(() => asValue(loadToken()))` defines a `Promise<Token>` dependency created once and awaited by its readers.
- A `withOverrides` callback that returns an awaitable value has it awaited, exactly like any promise returned from a callback, so returning a query builder runs its query.
  Use the value inside the callback, and use `createScope` when it has to outlive the callback.
  Returning it wrapped in an object avoids the await but hands back a value whose scope is already closed, together with everything that scope owned.
- A factory can read dependencies, but cannot create, enter, close, or retire scopes and installations in its own runtime; misuse throws `FactoryScopeOperationError`.
- A disposer, and any async work it starts, cannot read dependencies or manage scopes and installations in the runtime being closed; misuse throws `DisposerContextError`.
  Put everything cleanup needs into the dependency value itself.
- A factory reads from its own scope only; `scope.resolve` on a different scope throws `CrossScopeResolutionError`.
- Only the dependency calls made while a factory runs are tracked.
  Reads from `process.env`, `Date.now()`, or another async context are not.
- An override factory cannot read the previous value of the dependency it replaces; define a base dependency and a decorated one instead.
- A factory-created value is scoped only by the dependencies its factory reads.
  A value whose factory reads none stays shared even when it is first requested inside a scope.
- Read dependencies where you use them.
  A module-level `const db = useDb()` freezes one scope's value forever.
- Two copies of Ripple DI, separately installed or bundled, each run their own graph and cannot be combined.
  Do not pass dependencies or provisions between them, and do not call one copy's dependency inside a factory owned by the other.

## License

MIT
