# Ripple DI

**Next-generation dependency injection for TypeScript.**

Override a dependency for one request, test, or job.
Ripple DI gives everything that uses it the scoped version, reuses everything else, and cleans up temporary resources when the work is done.

No decorators, reflection metadata, string tokens, or container object are needed in application code.

See the [documentation](https://ilyasemenov.github.io/ripple-di/).

## Install

```sh
npm install ripple-di
```

## Usage

Define a database from configuration and use it as a normal imported function:

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

Replace only the configuration for one operation:

```ts
import { provide, withOverrides } from "ripple-di"

const users = await withOverrides(provide(useConfig, { databaseUrl: testDatabaseUrl }), () =>
  loadUsers(),
)
```

`useDb` calls `useConfig()`, so Ripple DI builds a separate database for the test configuration and closes it when the callback finishes, while everything unrelated keeps its instance.

## License

MIT
