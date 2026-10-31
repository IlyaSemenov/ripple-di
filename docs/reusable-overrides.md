# Reusable Overrides

## Name an override used in several places

When a dependency is replaced in one place, `withOverrides` with one `provide` is the clearest form.
When the same replacement repeats, turn it into a named helper with `createValueOverride`:

```ts
import { createValueOverride } from "ripple-di"

const withOpenAiClient = createValueOverride(useOpenAiClient)

await withOpenAiClient(client, () => createTextEmbedding(text))
```

Each call provides the given value to one callback, like `withOverrides` with a single `provide`.
Ownership options passed to `createValueOverride` apply to every call, and each call cleans up its own value:

```ts
const withConnection = createValueOverride(useConnection, { dispose: true })
```

## Apply the same overrides to every call

A long-lived object, such as an API client or a job worker, is created once, but each call through it needs the same overrides in a scope of its own.
Describe those overrides once with `createOverrideRunner`, and run each call through the runner:

```ts
import { createOverrideRunner, provide } from "ripple-di"

const jobOverrides = createOverrideRunner(() =>
  provide(useJobContext, createJobContext(), { dispose: true }),
)

const worker = createWorker(job => jobOverrides.run(() => handleJob(job)))
```

Every `run` call behaves like `withOverrides`: it creates a scope, runs the callback in it, and closes it afterward.
Concurrent calls stay isolated, while application values keep their identity.

The runner calls the function that builds the provisions again for every call, so a value handed over with `dispose` belongs to the call that created it.
When handing a value over, create a new value and provision on each call.

`wrap` turns a function into one that runs through the runner, so the worker above can take the handler directly:

```ts
const worker = createWorker(jobOverrides.wrap(handleJob))
```

The wrapped function passes its arguments and `this` through and returns a promise of the result.
Each of its calls is a separate `run`.

`extend` returns a runner with one more layer of overrides and leaves the original runner unchanged:

```ts
const tenantOverrides = jobOverrides.extend(() => provide(useTenantResolver, tenantResolver))

await tenantOverrides.run(() => handleRequest())
```

Where both layers provide the same dependency, the added layer wins.

A runner never keeps a scope open between calls.
For values that several operations share until you close them, use [`createScope`](./scopes).
