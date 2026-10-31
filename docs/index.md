---
layout: home

hero:
  name: Ripple DI
  text: Scoped dependency injection for TypeScript
  tagline: Override a dependency for one request, test, or job. The values derived from it are rebuilt, everything else is reused, and temporary resources are cleaned up afterward.
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started
    - theme: alt
      text: GitHub
      link: https://github.com/IlyaSemenov/ripple-di

features:
  - title: Plain function calls
    details: Application code imports a dependency and calls it. No decorators, reflection metadata, string tokens, or container object.
  - title: Transitive overrides
    details: Override one input, and only the values derived from it are rebuilt for that scope.
  - title: Async scopes
    details: Overrides follow a callback across await and stay isolated between concurrent requests.
  - title: Automatic cleanup
    details: Values created for a scope are disposed when it closes, and application values at shutdown.
---

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

Inside the callback, `useDb()` returns a separate database built from the test configuration, which is closed when the callback finishes.
See [Getting Started](./getting-started) for the rest of the API.
