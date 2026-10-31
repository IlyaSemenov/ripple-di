# Memoized Members

Decorate a getter or zero-argument method with `@memo` when it reads dependencies and its object can be used in scopes with different overrides:

```ts
import { memo } from "ripple-di"

class ViewModel {
  @memo
  get formatter() {
    return createFormatter(useLocale())
  }
}
```

The value is cached on the object, without keeping the object alive, and is rebuilt when it is read in a scope that overrides one of the dependencies it read, such as `useLocale`.
Overrides of unrelated dependencies keep the cached value.
A memo that reads another memo also depends on that memo's dependencies.

Each member of an object keeps only its latest value, so switching back to an earlier scope after an incompatible override builds the value again.

Use `memoize` for the same behavior without decorator syntax:

```ts
import { memoize } from "ripple-di"

const currentFormatter = memoize(() => createFormatter(useLocale()))
```

A memo is synchronous, takes no arguments, and does not cache errors.
Ripple DI does not clean up its values.

Only dependency calls are tracked: changing an ordinary field of the object does not rebuild a memo that reads it.
