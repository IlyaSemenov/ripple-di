# Multiple Runtimes

The module-level functions work with one built-in runtime, which is all most applications need.
Create a runtime of your own with `createRuntime` when one process hosts several independent graphs, each with its own dependencies, cached values, and shutdown:

```ts
import { createRuntime } from "ripple-di"

function createApplication(databaseUrl: string) {
  const runtime = createRuntime()

  const useConfig = runtime.defineDependency(() => ({ databaseUrl }))
  const useDb = runtime.defineDependency(() => createDb(useConfig().databaseUrl), {
    dispose: db => db.close(),
  })

  return { runtime, useDb }
}

const production = createApplication(productionDatabaseUrl)
const preview = createApplication(previewDatabaseUrl)

const productionUsers = await production.useDb().query("select * from users")
const previewUsers = await preview.useDb().query("select * from users")

await Promise.all([production.runtime.dispose(), preview.runtime.dispose()])
```

A dependency belongs to the runtime that defined it and cannot be read or overridden in another one.
The module-level `defineDependency` defines dependencies of the built-in runtime, so define every dependency of a separate graph through its own runtime, as `createApplication` does above.

A runtime has the same methods as the module-level API:

- `defineDependency`
- `defineFactoryDependency`
- `install`
- `resolve`
- `createScope`
- `withOverrides`
- `runDetached`
- `createDetachedStream`
- `createValueOverride`
- `createOverrideRunner`
- `dispose`

`runtime.resolve(useDb)` returns the same value as `useDb()`.

Pass `name` to `createRuntime` to see that name in error messages.
