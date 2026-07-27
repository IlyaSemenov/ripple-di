import { expect, it } from "bun:test"

import type { Dependency, Provision, Scope } from "ripple-di"
import { CrossRuntimeDependencyError, createRuntime, provide } from "ripple-di"

it("keeps dependency definitions and values isolated", async () => {
  const production = createRuntime({ name: "production" })
  const tests = createRuntime({ name: "tests" })
  const useProductionConfig = production.defineResource(() => "production")
  const useTestConfig = tests.defineResource(() => "tests")
  const useProductionResource = production.defineResource(() => ({
    config: useProductionConfig(),
  }))
  const useTestResource = tests.defineResource(() => ({
    config: useTestConfig(),
  }))

  const productionValue = useProductionResource()
  const testValue = useTestResource()
  expect(productionValue.config).toBe("production")
  expect(testValue.config).toBe("tests")
  expect(productionValue).not.toBe(testValue)

  await production.dispose()
  await tests.dispose()
})

it("resolves a Dependency through callable and Runtime APIs", async () => {
  const runtime = createRuntime()
  const useValue = runtime.defineSlot({ name: "value", default: () => 1 })

  expect(useValue()).toBe(1)
  expect(runtime.resolve(useValue)).toBe(1)
  await runtime.dispose()
})

it("rejects provisions and reads across Runtime boundaries", async () => {
  const runtimeA = createRuntime({ name: "runtime-a" })
  const runtimeB = createRuntime({ name: "runtime-b" })
  const useRuntimeAValue = runtimeA.defineSlot({
    name: "runtime-a-value",
    default: () => "runtime-a",
  })

  expect(() =>
    runtimeB.createScope([provide(useRuntimeAValue, "wrong")]),
  ).toThrow(CrossRuntimeDependencyError)
  expect(() => runtimeB.resolve(useRuntimeAValue)).toThrow(
    CrossRuntimeDependencyError,
  )

  const useConsumer = runtimeB.defineComputed(() => useRuntimeAValue(), {
    name: "consumer",
  })
  expect(() => runtimeB.resolve(useConsumer)).toThrow(
    CrossRuntimeDependencyError,
  )

  const scopeB = runtimeB.createScope()
  const useRuntimeBValue = runtimeB.defineSlot({
    name: "runtime-b-value",
    default: () => "runtime-b",
  })
  const useExplicitConsumer = runtimeA.defineComputed(
    () => scopeB.resolve(useRuntimeBValue),
    { name: "explicit-consumer" },
  )
  expect(() => runtimeA.resolve(useExplicitConsumer)).toThrow(
    CrossRuntimeDependencyError,
  )

  await scopeB.close()
  await runtimeA.dispose()
  await runtimeB.dispose()
})

it("distinguishes Runtime instances with the same name", async () => {
  const runtimeA = createRuntime({ name: "app" })
  const runtimeB = createRuntime({ name: "app" })
  const useValue = runtimeA.defineSlot({
    name: "value",
    default: () => "value",
  })

  let error: unknown
  try {
    runtimeB.resolve(useValue)
  } catch (caught) {
    error = caught
  }
  expect(error).toBeInstanceOf(CrossRuntimeDependencyError)
  expect((error as CrossRuntimeDependencyError).dependencyRuntimeName).toBe(
    "app",
  )
  expect((error as CrossRuntimeDependencyError).requestedRuntimeName).toBe(
    "app",
  )
  expect((error as Error).message).toBe(
    'Dependency "value" belongs to a different Runtime instance also named "app".',
  )

  await runtimeA.dispose()
  await runtimeB.dispose()
})

it("allows scope management in an independent Runtime during a factory", async () => {
  const runtimeA = createRuntime({ name: "runtime-a" })
  const runtimeB = createRuntime({ name: "runtime-b" })
  const scopeB = runtimeB.createScope()
  let childB: Scope | undefined
  let overridesResult: Promise<string> | undefined
  let scopeClose: Promise<void> | undefined
  const useOperations = runtimeA.defineComputed(
    () => {
      const runResult = scopeB.run(() => "run")
      childB = runtimeB.createScope()
      overridesResult = runtimeB.withOverrides([], () => "overrides")
      scopeClose = scopeB.close()
      return runResult
    },
    { name: "operations" },
  )

  expect(runtimeA.resolve(useOperations)).toBe("run")
  expect(await overridesResult).toBe("overrides")
  await scopeClose
  await childB?.close()

  let runtimeDispose: Promise<void> | undefined
  const useDispose = runtimeA.defineComputed(
    () => {
      runtimeDispose = runtimeB.dispose()
      return "disposed"
    },
    { name: "dispose" },
  )
  expect(runtimeA.resolve(useDispose)).toBe("disposed")
  await runtimeDispose
  await runtimeA.dispose()
})

it("explains metadata from invalid or duplicate package copies", async () => {
  const runtime = createRuntime()
  const foreignDependency = (() => "value") as Dependency<string>
  const foreignProvision = {} as Provision

  expect(() => runtime.resolve(foreignDependency)).toThrow(
    /package may be installed or bundled more than once/,
  )
  expect(() => runtime.createScope([foreignProvision])).toThrow(
    /package may be installed or bundled more than once/,
  )
  await runtime.dispose()
})
