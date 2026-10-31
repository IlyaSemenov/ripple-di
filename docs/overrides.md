# Overrides

Run a callback with replaced values using `withOverrides`:

```ts
import { provide, withOverrides } from "ripple-di"

const users = await withOverrides(
  provide(useConfig, {
    databaseUrl: "postgres://localhost/test",
  }),
  () => loadUsers(),
)
```

Inside the callback, `useConfig()` returns the test configuration, and `useDb()` returns a database built from it.
The production database is untouched, and the test database is closed when the callback finishes.

Overrides follow the callback across `await` and stay isolated between concurrent callbacks:

```ts
const [leftUsers, rightUsers] = await Promise.all([
  withOverrides(provide(useConfig, leftConfig), () => loadUsers()),
  withOverrides(provide(useConfig, rightConfig), () => loadUsers()),
])
```

## Override several dependencies

Pass a list of provisions:

```ts
await withOverrides([provide(useConfig, testConfig), provide(useClock, fixedClock)], () =>
  generateReport(),
)
```

## Build the replacement on first use

`provideFactory` replaces the factory instead of the value:

```ts
import { provideFactory, withOverrides } from "ripple-di"

await withOverrides(
  provideFactory(useDb, () => createFakeDb()),
  () => loadUsers(),
)
```

The replacement factory runs on the first call inside the callback, its dependency calls are recorded like those of the factory it replaces, and its value is cleaned up with the dependency's `dispose` when the callback finishes.

A function passed to `provide` becomes the value itself, so use `provideFactory` when the function should build the value.

A replacement factory cannot read the value it replaces.
To wrap that value, read it from a separate base dependency:

```ts
const useBaseMailer = defineDependency(() => createMailer())
const useMailer = defineDependency(() => useBaseMailer())

await withOverrides(
  provideFactory(useMailer, () => withDeliveryLog(useBaseMailer())),
  () => sendInvoices(),
)
```

## Make a dependency unavailable

Use `withoutProvider` to check how code behaves when a dependency is missing, even if the test setup already provides it:

```ts
import { withoutProvider, withOverrides } from "ripple-di"

await withOverrides(withoutProvider(useTenant), () => processRequest())
```

Inside the callback, `useTenant()` throws `MissingProviderError`, whether the value would come from an outer scope, the installation, or the dependency's own factory.
A nested `withOverrides` can provide it again.

## Return a value from the callback

`withOverrides` awaits what the callback returns before it closes the scope.
A returned query builder, or any other object with a `then` method, is therefore executed.
Use such an object inside the callback, or create a scope with [`createScope`](./scopes) when the object has to outlive the callback.

Do not return resources that the scope owns, such as the test database: they are already cleaned up when `withOverrides` returns.
To continue work after the callback finishes, start it with [`runDetached`](./background-work).
