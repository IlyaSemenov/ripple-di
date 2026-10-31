# Errors

Ripple DI reports mistakes in resolution and lifecycle with specific error classes, all extending `RippleError`, such as `MissingProviderError` for a dependency without a value and `DependencyCycleError` for a cycle.
Invalid arguments throw `TypeError` right away.

An error thrown by your own factory arrives wrapped in `FactoryError`, with the original error as its `cause`.
A failed factory is not cached, so the next call tries again.

## Name dependencies in messages

Error messages name the dependencies involved.
Pass `name` to choose that name:

```ts
const useConfig = defineDependency(loadConfig, { name: "config" })
```

Without it, a message uses the name of the factory function, or a generated name with the location of the `defineDependency` call, such as `dependency#21 (packages/core/src/openai/config.ts:36)`.
