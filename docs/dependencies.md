# Dependencies

A dependency is a function, such as `useConfig` or `useDb`, that returns its value for the current scope.
Define it once, in the module that owns it, and import it wherever the value is needed.

## Build a value from other dependencies

Pass a factory to `defineDependency`:

```ts
import { defineDependency } from "ripple-di"

const useClock = defineDependency(() => systemClock)
const usePublicUrl = defineDependency(() => createPublicUrl(useConfig()))
```

The factory runs on the first call, and later calls return the cached value.
Ripple DI records which dependencies the factory calls, so a scope that overrides `useConfig` gets its own `usePublicUrl`, while scopes that do not override it share one.

Only dependency calls made while the factory runs are recorded.
Reads of `process.env`, `Date.now()`, and other state outside Ripple DI never cause a rebuild, so put such inputs behind a dependency, like `useClock` above, when tests need to replace them.

Call a dependency where its value is used, not at module level:

```ts
// Wrong: keeps the value of whichever scope first loaded the module.
const db = useDb()
```

A function passed first to `defineDependency` is always its factory.
To make a function the value of a dependency, return it from the factory, as in `defineDependency(() => handler)`, or use [`defineFactoryDependency`](./factory-dependencies) for a function that takes runtime arguments.

When a factory catches an error thrown by a dependency it calls, its value is not shared between scopes: each scope that calls it builds a new one.

## Provide a value at a boundary

Some values exist only at the application, request, or task boundary, such as the configuration loaded at startup or the tenant of a request.
Define such a dependency without a factory, and provide its value where the boundary starts:

```ts
import { defineDependency, provide, withOverrides } from "ripple-di"

const useTenant = defineDependency<Tenant>()

await withOverrides(provide(useTenant, tenant), () => processRequest())
```

Values for the whole application are provided once with [`install`](./application).

## Clean up created values

Pass `dispose` when the values a dependency creates hold resources:

```ts
const useDb = defineDependency(() => createDb(useConfig().databaseUrl), {
  dispose: db => db.close(),
})
```

Ripple DI calls it for every value it created, when the scope that owns the value closes or the application shuts down; [Value Lifetime](./lifetime) explains which scope that is.
With `dispose: true`, it calls the value's `Symbol.asyncDispose` method, or `Symbol.dispose` when the value has no async one.

A disposer runs while its scope is closing, so it cannot call dependencies.
Keep everything that cleanup needs inside the value itself.

## Asynchronous values

A factory returns its value synchronously, because Ripple DI records only the dependency calls made before the factory returns.
An `async` factory is rejected.

To cache a promise as the value, wrap it in `asValue`:

```ts
import { asValue, defineDependency } from "ripple-di"

const useSession = defineDependency(() => asValue(loadSession()))
```

The dependencies that `loadSession` calls after its first `await` are not recorded.
They return the values of whichever scope first called `useSession`, even if the promise is then cached for the whole application, so call them before that `await`.

A value that only implements `then`, such as a query builder, is not a promise and needs no wrapper.
