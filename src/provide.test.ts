import { expect, it } from "bun:test"

import { collectProvisions, provide } from "./provide"
import { createRuntime } from "./runtime"
import { asValue } from "./value"

it("rejects dispose: true when the dependency has no disposer", async () => {
  const runtime = createRuntime()
  const useValue = runtime.defineDependency<object>({ name: "value" })

  expect(() => provide(useValue, {}, { dispose: true })).toThrow(
    'Dependency "value" has no cleanup configuration to reuse.',
  )
  await runtime.dispose()
})

it("rejects an asValue marker passed as a plain value", async () => {
  const runtime = createRuntime()
  const useToken = runtime.defineDependency<Promise<string>>({ name: "token" })

  expect(() =>
    // @ts-expect-error A marker is not a value.
    provide(useToken, asValue(Promise.resolve("value"))),
  ).toThrow(TypeError)
  await runtime.dispose()
})

it("collects provisions and omits false and nullish inputs", async () => {
  const runtime = createRuntime()
  const useConfig = runtime.defineDependency<string>({ name: "config" })
  const useClock = runtime.defineDependency<number>({ name: "clock" })
  const config = provide(useConfig, "test")
  const clock = provide(useClock, 42)

  expect(collectProvisions(config, false, null, [clock], undefined)).toEqual([
    config,
    clock,
  ])
  await runtime.dispose()
})
