# Ripple DI

Scoped dependency injection for TypeScript without container lookups in application code.

## Example

Define a database from configuration and use it as a normal imported function:

```ts
import { defineResource } from "ripple-di"

export const useConfig = defineResource(() => ({
  databaseUrl: import.meta.env.DATABASE_URL,
}))

export const useDb = defineResource(
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

Ripple DI sees that the database was created from `useConfig()`, creates a scoped database for the test configuration, and returns the users loaded through it.
The production database and unrelated services keep their existing instances.
The scoped database is closed when the callback finishes.

This is the ripple: override one input, and only the values that depend on it change.

## Install

```sh
npm install ripple-di
```

Ripple DI requires a server-side runtime that provides `node:async_hooks`, such as Node.js 18 or newer, Bun, or Deno with Node compatibility.
Browsers are not supported.
The package is published as ESM.

## Quick start

Define shared inputs and services at module boundaries.
Factories are lazy, so they run when application code first requests their value.

```ts
// config.ts
import { defineResource } from "ripple-di"

export const useConfig = defineResource(() => ({
  databaseUrl: import.meta.env.DATABASE_URL,
}))
```

```ts
// db.ts
import { defineResource } from "ripple-di"

import { useConfig } from "./config"

export const useDb = defineResource(
  () => createDb(useConfig().databaseUrl),
  { dispose: db => db.close() },
)
```

Application code imports and calls the dependency it needs.

```ts
import { useDb } from "./db"

export async function loadUsers() {
  return useDb().query("select * from users")
}
```

The return type of `useDb()` is inferred from `createDb`.

## Override a dependency

`withOverrides` runs a callback with temporary values and cleans up everything created for that callback afterward.

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

Inside the callback, `useConfig()` returns the test configuration.
Because `useDb` reads `useConfig()` in its factory, `useDb()` returns a database created for that configuration.
The production database remains unchanged.

Scoped values remain active across `await`, and parallel overrides remain isolated.

```ts
const [leftUsers, rightUsers] = await Promise.all([
  withOverrides([provide(useConfig, leftConfig)], () => loadUsers()),
  withOverrides([provide(useConfig, rightConfig)], () => loadUsers()),
])
```

## Required scoped inputs

Use `defineSlot` for a value that has no application-wide value and must be supplied at a boundary.
Tenants, authenticated users, and request data are typical slots.

```ts
import { defineSlot, provide, withOverrides } from "ripple-di"

const useTenant = defineSlot<Tenant>()

await withOverrides(
  [provide(useTenant, tenant)],
  () => processRequest(),
)
```

Reading a slot that was not provided throws `MissingProviderError`.

## Derived values

Use `defineComputed` for a lazy synchronous value derived from other dependencies.

```ts
const usePublicUrl = defineComputed(() => createPublicUrl(useConfig()))
```

Ripple DI memoizes the result and tracks the dependency calls made by the factory.

## Application shutdown

If a resource has a `dispose` callback, call `dispose()` during application shutdown.
It closes all remaining scopes and resources created through the module-level API.

```ts
import { dispose } from "ripple-di"

await dispose()
```

Resources created for `withOverrides` are cleaned up when that callback finishes and do not wait for application shutdown.

## Advanced usage

### Override values, factories, and ownership

For most overrides, pass an existing value to `provide`.

```ts
provide(useConfig, testConfig)
```

The value remains owned by the caller.
Ripple DI uses it in the scope but does not clean it up.

A function passed to `provide` remains a function value rather than becoming a factory.

```ts
const useHandler = defineSlot<() => string>()

provide(useHandler, () => "result")
```

Use `provideFactory` when the override should be created lazily for the scope.

```ts
provideFactory(useDb, () => createFakeDb())
```

The scope owns the value returned by the factory.
If `useDb` was defined by `defineResource` with a `dispose` callback, the same callback cleans up the fake database when the scope closes.
The override replaces how the value is created, while the Dependency keeps its cleanup policy.

Dependencies read inside the override factory are tracked in the same way as dependencies read by the original factory.
The factory must be synchronous.

Sometimes an existing value should become owned by the scope.
Pass `dispose: true` to use the cleanup already configured by `defineResource`:

```ts
provide(useDb, fakeDb, { dispose: true })
```

The scope then calls the `useDb` disposer when it closes.
Use an explicit callback when the supplied value needs different cleanup:

```ts
provide(useDb, fakeDb, { dispose: db => db.closeImmediately() })
```

Both forms transfer ownership of the supplied value to the scope.
That ownership-transferring provision can be installed in only one scope; create a separate value for each additional owner.
Installing it again throws `OwnedProvisionReuseError`.
Without the option, `provide` leaves ownership with the caller because Ripple DI did not create the value.

### Manage a scope explicitly

Prefer `withOverrides` when one callback defines the complete lifetime.
Use `createScope` when several operations must share the same overrides and close at a separately managed boundary.

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

`scope.run` activates an existing scope without closing it.
`scope.retire()` waits for existing child scopes to finish, while `scope.close()` closes the complete subtree.
Closing a scope cleans up resources created for that scope.
Reused application resources remain open.
Cleanup continues after individual disposer failures and reports all failures through `AggregateError`.

## Multiple runtimes

The module-level API uses one built-in global runtime.
Create another runtime only when one process must host multiple dependency graphs with isolated definitions, values, resources, and shutdown.

```ts
import { createRuntime } from "ripple-di"

function createApplication(databaseUrl: string) {
  const runtime = createRuntime()

  const useConfig = runtime.defineResource(() => ({ databaseUrl }))
  const useDb = runtime.defineResource(
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

A dependency belongs to the runtime that defined it and cannot be resolved or provided in another runtime.

Every runtime method has a module-level counterpart for the built-in runtime:

- `defineSlot`
- `defineComputed`
- `defineResource`
- `resolve`
- `createScope`
- `withOverrides`
- `dispose`

The simple API shown earlier is therefore the complete API of one runtime without requiring an application to create or pass that runtime around.

## Diagnostics

Reading a slot without a value throws `MissingProviderError`, dependency cycles throw `DependencyCycleError`, and asynchronous factories throw `AsyncFactoryError`.
Errors from user factories are wrapped in `FactoryError` with their original cause.
Factory errors are not cached, so a later read retries the factory.

These errors identify the Dependencies involved.
Give a Dependency a stable application-specific label with the `name` option:

```ts
const useConfig = defineResource(loadConfig, { name: "config" })
```

The name affects diagnostics only and does not change resolution or reuse.

## Limits

- Factories are synchronous.
- Factories can resolve Dependencies, but cannot manage scopes in their own Runtime; misuse throws `FactoryScopeOperationError`.
- Disposers may be asynchronous.
- Disposers and async work they start cannot resolve Dependencies or manage scopes in the Runtime being closed; misuse throws `DisposerContextError`.
- Include everything needed for cleanup in the resource value itself.
- An override factory cannot read the previous value of the Dependency it replaces; define separate base and decorated Dependencies instead.
- Only dependency calls made during factory evaluation are tracked.
- Reads from globals such as `import.meta.env`, `Date.now()`, or another async context are not tracked.
- A resource is scoped only by the Dependencies its factory reads; requesting a dependency-free resource inside a scope does not make it scope-local.
- Separately installed or bundled copies of Ripple DI can run independently, but their dependency graphs cannot be composed.
  Do not pass Dependencies or Provisions between copies or call a Dependency from one copy inside a factory owned by another.
- Resolve dependencies where they are used; a module-level `const db = useDb()` captures one scope's value permanently.
