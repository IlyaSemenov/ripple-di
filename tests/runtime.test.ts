import { describe, expect, it } from "bun:test"

import type { Dependency, Provision, Scope } from "ripple-di"
import {
  CrossRuntimeDependencyError,
  createRuntime,
  InstallationConflictError,
  MissingProviderError,
  provide,
  ScopeClosedError,
} from "ripple-di"

describe("runtime instances", () => {
  it("keeps dependency definitions and values isolated", async () => {
    const production = createRuntime({ name: "production" })
    const tests = createRuntime({ name: "tests" })
    const useProductionConfig = production.defineDependency(() => "production")
    const useTestConfig = tests.defineDependency(() => "tests")
    const useProductionService = production.defineDependency(() => ({
      config: useProductionConfig(),
    }))
    const useTestService = tests.defineDependency(() => ({
      config: useTestConfig(),
    }))

    const productionValue = useProductionService()
    const testValue = useTestService()
    expect(productionValue.config).toBe("production")
    expect(testValue.config).toBe("tests")
    expect(productionValue).not.toBe(testValue)

    await production.dispose()
    await tests.dispose()
  })

  it("resolves a dependency through callable and runtime APIs", async () => {
    const runtime = createRuntime()
    const useValue = runtime.defineDependency(() => 1, { name: "value" })

    expect(useValue()).toBe(1)
    expect(runtime.resolve(useValue)).toBe(1)
    await runtime.dispose()
  })
})

describe("installation", () => {
  it("uses installed providers as the fallback beneath scoped overrides", async () => {
    const runtime = createRuntime()
    const useConfig = runtime.defineDependency<string>({ name: "config" })
    const disposed: string[] = []
    let creationCount = 0
    const useService = runtime.defineDependency(
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
    const useConfig = runtime.defineDependency(() => "default", {
      name: "config",
    })
    const useView = runtime.defineDependency(() => ({ config: useConfig() }))
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
    const useOwned = runtime.defineDependency(() => ({}), {
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

  it("blocks installation while a detached root scope is alive", async () => {
    const runtime = createRuntime({ name: "app" })
    let releaseTail!: () => void
    const tailGate = new Promise<void>((resolve) => {
      releaseTail = resolve
    })
    const detachedTail = runtime.withDetachedOverrides([], () => tailGate)

    let conflict: unknown
    try {
      runtime.install([])
    } catch (caught) {
      conflict = caught
    }
    expect(conflict).toBeInstanceOf(InstallationConflictError)
    expect((conflict as InstallationConflictError).reason).toBe("live-scopes")

    releaseTail()
    await detachedTail
    const installation = runtime.install([])
    await installation.close()
    await runtime.dispose()
  })

  it("force-closes detached scopes with their installation", async () => {
    const runtime = createRuntime()
    let disposed = 0
    const useOwned = runtime.defineDependency<object>({
      name: "owned",
      dispose: () => {
        disposed += 1
      },
    })
    const installation = runtime.install([])
    let releaseTail!: () => void
    const tailGate = new Promise<void>((resolve) => {
      releaseTail = resolve
    })
    const detachedTail = runtime.withDetachedOverrides(
      provide(useOwned, {}, { dispose: true }),
      async () => {
        useOwned()
        await tailGate
      },
    )

    await installation.close()
    expect(disposed).toBe(1)
    releaseTail()
    await detachedTail
    await runtime.dispose()
  })

  it("closes an active installation during runtime disposal", async () => {
    const runtime = createRuntime()
    let disposeCount = 0
    const useOwnedValue = runtime.defineDependency(() => ({}), {
      dispose: () => {
        disposeCount += 1
      },
    })
    const installation = runtime.install([])
    runtime.resolve(useOwnedValue)

    await runtime.dispose()
    expect(disposeCount).toBe(1)
    await installation.close()
    expect(disposeCount).toBe(1)
    expect(() => runtime.install([])).toThrow(ScopeClosedError)
  })

  it("reports installation cleanup failures and permits replacement", async () => {
    const runtime = createRuntime()
    const cleanupError = new Error("cleanup failed")
    const useConfig = runtime.defineDependency<object>({ name: "config" })
    const useOwnedValue = runtime.defineDependency(
      () => ({ config: useConfig() }),
      {
        dispose: () => {
          throw cleanupError
        },
      },
    )
    const installation = runtime.install([provide(useConfig, {})])
    runtime.resolve(useOwnedValue)

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
})

describe("cross-runtime boundaries", () => {
  it("rejects provisions and reads across runtime boundaries", async () => {
    const runtimeA = createRuntime({ name: "runtime-a" })
    const runtimeB = createRuntime({ name: "runtime-b" })
    const useRuntimeAValue = runtimeA.defineDependency(() => "runtime-a", {
      name: "runtime-a-value",
    })

    expect(() =>
      runtimeB.createScope([provide(useRuntimeAValue, "wrong")]),
    ).toThrow(CrossRuntimeDependencyError)
    expect(() => runtimeB.resolve(useRuntimeAValue)).toThrow(
      CrossRuntimeDependencyError,
    )

    const useConsumer = runtimeB.defineDependency(() => useRuntimeAValue(), {
      name: "consumer",
    })
    expect(() => runtimeB.resolve(useConsumer)).toThrow(
      CrossRuntimeDependencyError,
    )

    const scopeB = runtimeB.createScope()
    const useRuntimeBValue = runtimeB.defineDependency(() => "runtime-b", {
      name: "runtime-b-value",
    })
    const useExplicitConsumer = runtimeA.defineDependency(
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

  it("distinguishes runtime instances with the same name", async () => {
    const runtimeA = createRuntime({ name: "app" })
    const runtimeB = createRuntime({ name: "app" })
    const useValue = runtimeA.defineDependency(() => "value", {
      name: "value",
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
      'Dependency "value" belongs to a different runtime instance also named "app".',
    )

    await runtimeA.dispose()
    await runtimeB.dispose()
  })

  it("allows scope management in an independent runtime during a factory", async () => {
    const runtimeA = createRuntime({ name: "runtime-a" })
    const runtimeB = createRuntime({ name: "runtime-b" })
    let installationClose: Promise<void> | undefined
    const useInstallation = runtimeA.defineDependency(
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
    const useOperations = runtimeA.defineDependency(
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
    const useDispose = runtimeA.defineDependency(
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
})
