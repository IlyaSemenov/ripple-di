# Explicit Scopes

`withOverrides` fits when one callback covers the whole lifetime of the overrides.
When several operations share the same overrides and the scope closes at a boundary you manage, create the scope with `createScope`:

```ts
import { createScope, provide } from "ripple-di"

await using scope = createScope(provide(useConfig, tenantConfig))
await scope.run(() => processTenant())
```

`await using` closes the scope at the end of the block; without it, call `scope.close()`.

- `scope.run` makes the scope current for a callback, returns the callback's result as it is, and leaves the scope open.
- `scope.resolve(useDb)` reads a dependency from that scope rather than the current one.
  A dependency factory can read dependencies only from its own scope.
- `scope.createScope` and `scope.withOverrides` create children of that scope instead of the current one.
- `scope.close()` closes the scope and its children, while `scope.retire()` waits for the children to close first.
  Closing cleans up the values the scope owns, and values reused from outer scopes stay open.

Close the child scopes created inside a `withOverrides` callback before it returns; Ripple DI closes the ones left open and reports an error.

Installations and runtimes support `await using` in the same way.
