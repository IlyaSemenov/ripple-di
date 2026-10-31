# Application Wiring

Some dependencies get their real value only when the application starts.
Supply them once for the whole process with `install`:

```ts
// dependencies.ts
import { defineDependency } from "ripple-di"

export const useWebConfig = defineDependency<WebConfig>()
export const useTenantResolver = defineDependency<TenantResolver>()
```

```ts
// startup.ts
import { dispose, install, provide } from "ripple-di"

import { useTenantResolver, useWebConfig } from "./dependencies"

install([provide(useWebConfig, config), provide(useTenantResolver, resolveTenant)])

try {
  await runApplication()
} finally {
  await dispose()
}
```

Installed values apply everywhere: in request handlers, background jobs, tests, and any other code, while an override in a scope still takes precedence.
Installed factories run only when their values are first requested.

Install once during startup, before creating any scope.
Every process and worker thread installs its own values.

## Collect the provisions of several modules

A runtime has one installation, so modules do not install their own values.
Let each module export a function that builds its provisions, and install them all in the composition root:

```ts
// core/provisions.ts
export function getCoreProvisions() {
  return [provide(useDbConfig, dbConfig), provide(useEmailTransport, emailTransport)]
}
```

```ts
// platform/provisions.ts
export function getPlatformProvisions() {
  return [provide(useAgentChatConfig, agentChatConfig)]
}
```

```ts
// startup.ts
import { dispose, install } from "ripple-di"

install(getCoreProvisions(), platformEnabled && getPlatformProvisions())

onShutdown(() => dispose())
```

`install` accepts provisions and lists of them, and skips `false`, `null`, and `undefined`, so a module can be wired conditionally.
To combine provisions before installing them, such as to return them from a function, pass the same arguments to `collectProvisions`.

A function rather than a ready-made list gives each installation provisions of its own, which matters for values handed over with `dispose`: such a value can belong to one installation only.

Tests have a single composition root too: install the provisions of every module the suite needs from one preload file.

## Shut down

Call `dispose()` when the application stops:

```ts
import { dispose } from "ripple-di"

await dispose()
```

It closes the installation and every scope, and cleans up every value that Ripple DI still owns.
The runtime cannot be used afterward, so do not call `dispose()` between tests; use [overrides](./testing) for each test instead.

Values created inside `withOverrides` do not wait for shutdown; they are cleaned up when their callback finishes.

## Replace the installation

Close the installation before installing a replacement:

```ts
const installation = install(getProvisions(firstConfig))

await installation.close()
install(getProvisions(secondConfig))
```

Closing an installation removes its values and cleans up those it owns, including values built from what it provided.
Values built without anything the installation provided stay cached for the next installation.

For a resource that each installation must create and clean up itself, define the dependency without a factory and let its module export a function that returns `provideFactory` for it.
