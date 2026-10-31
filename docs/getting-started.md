# Getting Started

## Install

```sh
npm install ripple-di
```

Ripple DI runs on Node.js 18.18 or newer, Bun, and Deno with Node compatibility.
It relies on `node:async_hooks`, so it does not run in browsers.
The package is published as ESM only.

## Define dependencies

Define each dependency once, in the module that owns it, and call it wherever the value is needed:

```ts
import { defineDependency } from "ripple-di"

export const useConfig = defineDependency(() => ({
  databaseUrl: process.env.DATABASE_URL,
}))

export const useDb = defineDependency(() => createDb(useConfig().databaseUrl), {
  dispose: db => db.close(),
})

export async function loadUsers() {
  return useDb().query("select * from users")
}
```

The factory of `useDb` runs on the first call, and later calls return the same database.

## Override a dependency

Replace a value for one operation with `withOverrides`:

```ts
import { provide, withOverrides } from "ripple-di"

const users = await withOverrides(provide(useConfig, { databaseUrl: testDatabaseUrl }), () =>
  loadUsers(),
)
```

`useDb` calls `useConfig()`, so inside the callback Ripple DI builds a separate database for the test configuration and loads the users through it.
The production database and everything unrelated to the configuration keep their instances, and the test database is closed when the callback finishes.

This is the ripple: override one input, and only the values derived from it are rebuilt.

## Design trade-off

Ripple DI is an ambient service locator by design: code imports a dependency and calls it instead of receiving it as an argument.

This makes dependencies convenient to use and override, but also less explicit: the signature of a function does not show which dependencies it reads.

## What's next

- Define an input, derived value, or service: [`defineDependency`](./dependencies).
- Define a replaceable function that takes runtime arguments: [`defineFactoryDependency`](./factory-dependencies).
- Supply the application's values at startup: [`install`](./application) with `provide` or `provideFactory`.
- Combine the provisions of several modules: [`collectProvisions`](./application#collect-the-provisions-of-several-modules).
- Replace values for one callback: [`withOverrides`](./overrides) with `provide` or `provideFactory`.
- Make a dependency unavailable: [`withoutProvider`](./overrides#make-a-dependency-unavailable).
- Keep one scope open across several operations: [`createScope`](./scopes).
- Continue work after the current scope closes: [`runDetached`](./background-work).
- Read an async source after the current scope closes: [`createDetachedStream`](./background-work#read-an-async-source).
- Name an override used in several places: [`createValueOverride`](./reusable-overrides).
- Apply the same overrides to many independent calls: [`createOverrideRunner`](./reusable-overrides#apply-the-same-overrides-to-every-call).
- Cache a getter or method that reads dependencies: [`@memo`](./memo).
- Shut everything down: [`dispose`](./application#shut-down).
