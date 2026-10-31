# Background Work

Start work that continues after the current request or scope closes with `runDetached`:

```ts
import { runDetached } from "ripple-di"

const backgroundTask = runDetached(() => updateTenantSearchIndex())

trackBackgroundTask(backgroundTask)
```

The work keeps the overrides that are active when `runDetached` is called, applied in new scopes of its own, so the request can close while the work continues.

- Values provided with `provide` keep their identity.
- Factories provided with `provideFactory` run again in the new scopes, and their values are cleaned up with them.
- Dependencies removed with `withoutProvider` stay removed.
- A value handed over with `dispose` cannot belong to both contexts, so `runDetached` rejects when one is active.

To keep a value away from the detached work, remove or replace it inside:

```ts
import { runDetached, withoutProvider, withOverrides } from "ripple-di"

const backgroundTask = runDetached(() =>
  withOverrides(withoutProvider(useCurrentUser), () => updateTenantSearchIndex()),
)
```

The returned promise settles after the detached scopes are cleaned up, so put everything that needs them, including finalization, inside the callback:

```ts
runDetached(() => runBackgroundTask().finally(finalizeBackgroundTask))
```

Detached work belongs to the application wiring: closing the installation or calling `dispose()` closes it, and unfinished detached work blocks a new `install()`.

## Read an async source

The body of an async generator runs when something reads from it, not when the generator is created.
A subscription opened inside a request therefore reads its dependencies after the request scope has closed.
Open such a source with `createDetachedStream`, which keeps a detached context for every read until the reader is done; `runDetached` rejects a callback that returns a generator.

```ts
import { setTimeout as delay } from "node:timers/promises"
import { createDetachedStream } from "ripple-di"

function subscribeToOrders(signal: AbortSignal) {
  return createDetachedStream(
    async function* (scope, signal) {
      const db = useDb()
      while (!signal.aborted) {
        yield* await db.query("select * from order_events")
        await delay(1_000, undefined, { signal })
      }
    },
    { signal },
  )
}
```

The `open` callback runs immediately inside the detached scopes, so anything it subscribes to before returning the source is in place when `createDetachedStream` returns.
Every read then runs in the same scopes.

Read the stream with `for await` or declare it with `await using`; both close the scopes when the reader leaves.
The scopes also close when the source finishes, a read fails, or the external signal aborts.

The second argument of `open` is a signal that aborts when the stream starts closing for any reason.
Pass it to the operations inside the source, such as the `delay` above, so that they stop promptly; an operation that ignores it delays cleanup until it finishes on its own.
After the signal aborts, an error that is its `reason` or is named `AbortError` ends the stream normally, so the source does not need to catch it; other errors still reach the reader.
To tell external cancellation from other reasons for closing, check the external signal directly.

After external cancellation, await `return()` or `Symbol.asyncDispose` on the stream to wait for cleanup and see its errors.
