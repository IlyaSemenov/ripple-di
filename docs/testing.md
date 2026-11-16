# Testing

Install the wiring the suite needs once for the whole test process, from the preload or setup file the test runner already has.
Then give each test its own values with `withOverrides`:

```ts
import { provide, withOverrides } from "ripple-di"

test("loads users from the test database", () =>
  withOverrides(provide(useConfig, testConfig), () => loadUsers()))
```

The overrides last exactly as long as the callback, so tests that run in parallel do not see each other's values.

## Share expensive values between tests

When several tests can reuse values that are expensive to build, create one scope for them and run each test inside it:

```ts
import { createScope, provide, type Scope } from "ripple-di"

let scope: Scope

beforeAll(() => {
  scope = createScope(provide(useConfig, testConfig))
})

afterAll(() => scope.close())

test("lists users", () => scope.run(() => listUsers()))
test("creates a user", () => scope.run(() => createUser()))
```

The tests share every value cached in that scope, so keep in it only values they can safely reuse.

A scope is current only inside `scope.run` or `withOverrides`, so entering it in a hook does not carry it into the tests that follow:

```ts
// Wrong: the scope is current inside this callback and nowhere else.
beforeAll(() => scope.run(() => {}))
```

A test that creates a child scope of its own closes it itself instead of leaving it open until `afterAll`.

## Apply the same overrides to every test

When every test in a file needs the same overrides in a separate scope, wrap each test with an [override runner](./reusable-overrides#apply-the-same-overrides-to-every-call):

```ts
import { createOverrideRunner, provide } from "ripple-di"

const testConfigOverrides = createOverrideRunner(() => provide(useConfig, testConfig))

test(
  "lists users",
  testConfigOverrides.wrap(() => listUsers()),
)
test(
  "creates a user",
  testConfigOverrides.wrap(() => createUser()),
)
```

## Check that an expensive value is shared

A value is built again in every scope that overrides a dependency its factory called, including calls made by library code that the factory runs, such as a callback.
To make sure an expensive value, such as a database client, is not built again for each request, read it in two scopes with different overrides and compare the results:

```ts
import { provide, withOverrides } from "ripple-di"

test("requests share one database client", async () => {
  const [left, right] = await Promise.all([
    withOverrides(provide(useTenant, leftTenant), () => useDb()),
    withOverrides(provide(useTenant, rightTenant), () => useDb()),
  ])
  expect(right).toBe(left)
})
```

When the values differ, call `inspectDependency` with the same overrides to find the dependency that causes it:

```ts
import { inspectDependency } from "ripple-di"

await withOverrides(provide(useTenant, leftTenant), () => {
  for (const input of inspectDependency(useDb).inputs) {
    console.log(input.path.join(" → "))
  }
})
// db → query-builder
// db → tenant
// db → query-builder → config
```

It lists every dependency that the value was built from, directly or through other dependencies, with the [names](./errors#name-dependencies-in-messages) of the dependencies that lead to it.
A scope that overrides any of them gets a value of its own.

## Repeat a suite in one process

Some test runners repeat suite hooks in one process without evaluating the preload again, such as Bun with `--rerun-each`.
Because `dispose()` closes the runtime for good, a preload that installs once and calls `dispose()` in `afterAll` fails on the second run.
Run each repetition in a separate process, or install in `beforeAll` and close that installation in `afterAll`:

```ts
import { install, type Installation } from "ripple-di"

let installation: Installation

beforeAll(() => {
  installation = install(getTestProvisions())
})

afterAll(() => installation.close())
```

Build the provisions inside `beforeAll`, so that each run hands its values over to its own installation.
