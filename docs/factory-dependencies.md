# Factory Dependencies

Use `defineFactoryDependency` for a replaceable function that application code calls with runtime arguments, such as a logger for a named area:

```ts
import { defineFactoryDependency } from "ripple-di"

const useLog = defineFactoryDependency(
  (area: string) =>
    (...values: unknown[]) =>
      console.log(`[${area}]`, ...values),
)

const billingLog = useLog("billing")
billingLog("invoice created", 42)
```

Each call invokes the function selected for the current scope with the given arguments.
Ripple DI does not cache the results, does not record the arguments, and does not clean up what the function returns.

Replace the function with `provide`:

```ts
const messages: unknown[][] = []

await withOverrides(
  provide(
    useLog,
    area =>
      (...values) =>
        messages.push([area, ...values]),
  ),
  () => useLog("billing")("invoice created", 42),
)
```

Define it without a function when the application or a test must always supply one:

```ts
type SendEmail = (message: EmailMessage) => Promise<void>

const sendEmail = defineFactoryDependency<SendEmail>()
```

When a dependency factory calls a factory dependency, it records both the factory dependency and the dependencies that the selected function calls.
For example, when `useView` calls `useLog("billing")`, and the selected function calls `useConfig()`, overriding either `useLog` or `useConfig` rebuilds `useView`.

`resolve(useLog)` returns the selected function without calling it.
Use `provideFactory(useLog, () => createLogFunction())` only when building the function itself should be lazy and its dependency calls recorded.
