# ripple-di

## 2.3.3

### Patch Changes

- 5020564: Export `ProvisionCollectionInput` so wrappers around `install` and `collectProvisions` can type their accepted inputs directly.

## 2.3.2

### Patch Changes

- 435638e: Allow `defineFactoryDependency<TFactory>()` to declare a factory dependency without a built-in implementation.

## 2.3.1

### Patch Changes

- 6491307: Allow `install` to accept the same individual, listed, and conditional provision inputs as `collectProvisions` without an intermediate collection.

## 2.3.0

### Minor Changes

- 71effe1: Add `collectProvisions` for combining individual, listed, and conditional provisions into one installation input.

## 2.2.0

### Minor Changes

- 0f67797: Add dependency-aware memoization for object getters, zero-argument methods, and standalone computations.

## 2.1.0

### Minor Changes

- cecb255: Add `defineFactoryDependency` for defining overrideable factories that application code calls directly with runtime arguments.

## 2.0.0

### Major Changes

- 1a79ade: Use `dispose: true` to clean up dependency values through `Symbol.asyncDispose` or `Symbol.dispose`, and use `Scope`, `Installation`, and `Runtime` with `await using`.
  Node.js 18.18 or newer is now required.

## 1.2.0

### Minor Changes

- 4ab721d: Add `withDetachedContext` to continue all current override layers outside their original scope lifecycle.

## 1.1.0

### Minor Changes

- 6b3dbe8: Add `withDetachedOverrides` for scoped work that does not inherit the current ambient scope.

## 1.0.1

### Patch Changes

- 5d2ac70: Make dependency errors easier to trace by showing where unnamed dependencies were defined and using named factories as diagnostic names.

## 1.0.0

### Major Changes

- db8e650: Initial release.
