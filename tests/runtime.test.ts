import { expect, it } from "bun:test"

import type { Dependency, Provision, Scope } from "ripple-di"
import {
  CrossRuntimeDependencyError,
  createRuntime,
  InstallationConflictError,
  MissingProviderError,
  provide,
  ScopeClosedError,
} from "ripple-di"

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

it("uses installed providers as the fallback beneath scoped overrides", async () => {
  const runtime = createRuntime()
  const useConfig = runtime.defineSlot<string>({ name: "config" })
  const disposed: string[] = []
  let creationCount = 0
  const useService = runtime.defineResource(
    () => {
      creationCount += 1
      return { config: useConfig() }
    },
    {
      name: "service",
      dispose: (service) => {
        disposed.push(service.config)
      },
    },
  )
  const installation = runtime.install([provide(useConfig, "installed")])

  expect(creationCount).toBe(0)
  const installedService = await new Promise<ReturnType<typeof useService>>(
    (resolve) => {
      queueMicrotask(() => resolve(useService()))
    },
  )
  expect(installedService.config).toBe("installed")
  expect(creationCount).toBe(1)

  await runtime.withOverrides([provide(useConfig, "scoped")], () => {
    expect(useService().config).toBe("scoped")
  })
  expect(disposed).toEqual(["scoped"])
  expect(runtime.resolve(useService)).toBe(installedService)

  const child = runtime.createScope()
  expect(child.resolve(useService)).toBe(installedService)
  await installation.close()
  expect(disposed).toEqual(["scoped", "installed"])
  expect(() => child.resolve(useService)).toThrow(ScopeClosedError)
  expect(() => runtime.resolve(useConfig)).toThrow(MissingProviderError)
  await runtime.dispose()
})

it("allows late and repeated installations only across safe boundaries", async () => {
  const runtime = createRuntime({ name: "app" })
  const useConfig = runtime.defineSlot({
    name: "config",
    default: () => "default",
  })
  const useView = runtime.defineComputed(() => ({ config: useConfig() }))
  const defaultView = runtime.resolve(useView)

  const installation = runtime.install([provide(useConfig, "installed")])
  expect(runtime.resolve(useView)).toEqual({ config: "installed" })

  let conflict: unknown
  try {
    runtime.install([])
  } catch (caught) {
    conflict = caught
  }
  expect(conflict).toBeInstanceOf(InstallationConflictError)
  expect((conflict as InstallationConflictError).reason).toBe(
    "active-installation",
  )

  const closing = installation.close()
  conflict = undefined
  try {
    runtime.install([])
  } catch (caught) {
    conflict = caught
  }
  expect(conflict).toBeInstanceOf(InstallationConflictError)
  expect((conflict as InstallationConflictError).reason).toBe(
    "closing-installation",
  )
  expect((conflict as Error).message).toContain("Await Installation.close()")
  await closing
  expect(runtime.resolve(useView)).toBe(defaultView)

  const scope = runtime.createScope()
  const disposed: object[] = []
  const useOwned = runtime.defineResource(() => ({}), {
    dispose: (value) => {
      disposed.push(value)
    },
  })
  const ownedValue = {}
  const ownedProvision = provide(useOwned, ownedValue, { dispose: true })

  conflict = undefined
  try {
    runtime.install([ownedProvision])
  } catch (caught) {
    conflict = caught
  }
  expect(conflict).toBeInstanceOf(InstallationConflictError)
  expect((conflict as InstallationConflictError).reason).toBe("live-scopes")
  expect((conflict as InstallationConflictError).scopeNames).toHaveLength(1)
  expect((conflict as InstallationConflictError).scopeNames[0]).toMatch(
    /^app\/scope-\d+$/,
  )

  await scope.close()
  const replacement = runtime.install([ownedProvision])
  await replacement.close()
  expect(disposed).toEqual([ownedValue])

  const finalInstallation = runtime.install([])
  await finalInstallation.close()
  await runtime.dispose()
})

it("closes an active installation during Runtime disposal", async () => {
  const runtime = createRuntime()
  let disposeCount = 0
  const useResource = runtime.defineResource(() => ({}), {
    dispose: () => {
      disposeCount += 1
    },
  })
  const installation = runtime.install([])
  runtime.resolve(useResource)

  await runtime.dispose()
  expect(disposeCount).toBe(1)
  await installation.close()
  expect(disposeCount).toBe(1)
  expect(() => runtime.install([])).toThrow(ScopeClosedError)
})

it("reports installation cleanup failures and permits replacement", async () => {
  const runtime = createRuntime()
  const cleanupError = new Error("cleanup failed")
  const useConfig = runtime.defineSlot<object>({ name: "config" })
  const useResource = runtime.defineResource(() => ({ config: useConfig() }), {
    dispose: () => {
      throw cleanupError
    },
  })
  const installation = runtime.install([provide(useConfig, {})])
  runtime.resolve(useResource)

  const close = installation.close()
  expect(installation.close()).toBe(close)
  const closeError = await close.then(
    () => undefined,
    (error) => error as AggregateError,
  )
  expect(closeError).toBeInstanceOf(AggregateError)
  expect(closeError?.errors).toEqual([cleanupError])

  const replacement = runtime.install([])
  await replacement.close()
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
  let installationClose: Promise<void> | undefined
  const useInstallation = runtimeA.defineComputed(
    () => {
      installationClose = runtimeB.install([]).close()
      return "installed"
    },
    { name: "installation" },
  )

  expect(runtimeA.resolve(useInstallation)).toBe("installed")
  await installationClose

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
