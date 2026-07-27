import { describe, expect, it } from "bun:test"

import type { Dependency } from "ripple-di"
import {
  AsyncFactoryError,
  CrossScopeResolutionError,
  createRuntime,
  DependencyCycleError,
  FactoryError,
  FactoryScopeOperationError,
  MissingProviderError,
  provide,
  provideFactory,
} from "ripple-di"

// Distinctive successful value for the branch that avoids the test cycle.
const NON_CYCLIC_VALUE = 42

describe("resolution and tracking", () => {
  it("reports a missing slot", async () => {
    const runtime = createRuntime()
    const useMissing = runtime.defineSlot<string>({ name: "missing" })
    const useMiddle = runtime.defineComputed(() => useMissing(), {
      name: "middle",
    })
    const useOuter = runtime.defineComputed(() => useMiddle(), {
      name: "outer",
    })

    let error: unknown
    try {
      runtime.resolve(useOuter)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(MissingProviderError)
    expect((error as MissingProviderError).path).toEqual([
      "outer",
      "middle",
      "missing",
    ])
    expect((error as Error).message).toBe(
      'Dependency "missing" has no provider while resolving ' +
        "outer \u2192 middle \u2192 missing.",
    )
    await runtime.dispose()
  })

  it("generates a diagnostic name for an anonymous slot", async () => {
    const runtime = createRuntime()
    const useAnonymous = runtime.defineSlot<string>()

    expect(() => runtime.resolve(useAnonymous)).toThrow(
      /^Dependency "slot#\d+" has no provider\.$/,
    )
    await runtime.dispose()
  })

  it("evaluates factories lazily once and caches undefined", async () => {
    const runtime = createRuntime()
    let calls = 0
    const useValue = runtime.defineComputed(
      () => {
        calls += 1
        return undefined
      },
      { name: "undefined" },
    )

    expect(calls).toBe(0)
    expect(runtime.resolve(useValue)).toBeUndefined()
    expect(runtime.resolve(useValue)).toBeUndefined()
    expect(calls).toBe(1)
    await runtime.dispose()
  })

  it("distinguishes function values from explicit factory provisions", async () => {
    const runtime = createRuntime()
    const useHandler = runtime.defineSlot<() => string>({ name: "handler" })
    const valueScope = runtime.createScope([provide(useHandler, () => "value")])
    let factoryCalls = 0
    const factoryScope = runtime.createScope([
      provideFactory(useHandler, () => {
        factoryCalls += 1
        return () => "factory"
      }),
    ])

    expect(valueScope.resolve(useHandler)()).toBe("value")
    expect(factoryCalls).toBe(0)
    expect(factoryScope.resolve(useHandler)()).toBe("factory")
    expect(factoryScope.resolve(useHandler)()).toBe("factory")
    expect(factoryCalls).toBe(1)

    await valueScope.close()
    await factoryScope.close()
    await runtime.dispose()
  })

  it("does not run a default factory behind a direct override", async () => {
    const runtime = createRuntime()
    let calls = 0
    const useValue = runtime.defineSlot({
      name: "value",
      default: () => {
        calls += 1
        return "default"
      },
    })
    const scope = runtime.createScope([provide(useValue, "override")])

    expect(scope.resolve(useValue)).toBe("override")
    expect(calls).toBe(0)
    await scope.close()
    await runtime.dispose()
  })

  it("uses nearest overrides and preserves the exact parent identity", async () => {
    const runtime = createRuntime()
    const useConfig = runtime.defineSlot({
      name: "config",
      default: () => "root",
    })
    const useView = runtime.defineComputed(() => ({ config: useConfig() }), {
      name: "view",
    })
    const rootValue = runtime.resolve(useView)
    const child = runtime.createScope([provide(useConfig, "child")])
    const nested = child.createScope([provide(useConfig, "nested")])

    expect(child.resolve(useView).config).toBe("child")
    expect(nested.resolve(useView).config).toBe("nested")
    await nested.close()
    await child.close()
    expect(runtime.resolve(useView)).toBe(rootValue)
    await runtime.dispose()
  })

  it("treats every binding installation as a new identity", async () => {
    const runtime = createRuntime()
    const value = { config: "same" }
    const useConfig = runtime.defineSlot<object>({ name: "config" })
    const useView = runtime.defineComputed(() => ({ config: useConfig() }), {
      name: "view",
    })
    const left = runtime.createScope([provide(useConfig, value)])
    const right = runtime.createScope([provide(useConfig, value)])

    expect(left.resolve(useConfig)).toBe(right.resolve(useConfig))
    expect(left.resolve(useView)).not.toBe(right.resolve(useView))

    await left.close()
    await right.close()
    await runtime.dispose()
  })

  it("tracks only the active conditional branch and propagates transitive stamps", async () => {
    const runtime = createRuntime()
    const useFlag = runtime.defineSlot({ name: "flag", default: () => true })
    const useLeft = runtime.defineSlot({ name: "left", default: () => "left" })
    const useRight = runtime.defineSlot({
      name: "right",
      default: () => "right",
    })
    const useChoice = runtime.defineComputed(
      () => ({ value: useFlag() ? useLeft() : useRight() }),
      { name: "choice" },
    )
    const useOuter = runtime.defineComputed(() => ({ choice: useChoice() }), {
      name: "outer",
    })
    const rootChoice = runtime.resolve(useChoice)
    const rootOuter = runtime.resolve(useOuter)
    const inactive = runtime.createScope([provide(useRight, "changed")])
    const switched = runtime.createScope([provide(useFlag, false)])
    const transitive = runtime.createScope([provide(useLeft, "changed")])

    expect(inactive.resolve(useChoice)).toBe(rootChoice)
    expect(switched.resolve(useChoice).value).toBe("right")
    expect(switched.resolve(useChoice)).not.toBe(rootChoice)
    expect(transitive.resolve(useOuter)).not.toBe(rootOuter)
    expect(transitive.resolve(useOuter).choice.value).toBe("changed")

    await inactive.close()
    await switched.close()
    await transitive.close()
    await runtime.dispose()
  })

  it("detects a complete cycle but ignores an inactive conditional cycle", async () => {
    const runtime = createRuntime()
    let useA!: Dependency<number>
    let useB!: Dependency<number>
    useA = runtime.defineComputed(() => useB(), { name: "A" })
    useB = runtime.defineComputed(() => useA(), { name: "B" })
    const useFlag = runtime.defineSlot({ name: "flag", default: () => false })
    let useConditional!: Dependency<number>
    useConditional = runtime.defineComputed(
      () => (useFlag() ? useConditional() : NON_CYCLIC_VALUE),
      { name: "conditional" },
    )

    try {
      runtime.resolve(useA)
      throw new Error("expected a cycle")
    } catch (error) {
      expect(error).toBeInstanceOf(DependencyCycleError)
      expect((error as DependencyCycleError).path).toEqual(["A", "B", "A"])
    }
    expect(runtime.resolve(useConditional)).toBe(NON_CYCLIC_VALUE)
    await runtime.dispose()
  })

  it("rejects async factories", async () => {
    const runtime = createRuntime()
    const useAsync = runtime.defineComputed(() => Promise.resolve("value"), {
      name: "async",
    })

    expect(() => runtime.resolve(useAsync)).toThrow(AsyncFactoryError)
    await runtime.dispose()
  })

  it("wraps user errors with cause/path and retries them", async () => {
    const runtime = createRuntime()
    const cause = new Error("boom")
    let calls = 0
    const useFlaky = runtime.defineComputed(
      () => {
        calls += 1
        if (calls === 1) {
          throw cause
        }
        return { calls }
      },
      { name: "flaky" },
    )

    try {
      runtime.resolve(useFlaky)
      throw new Error("expected a factory error")
    } catch (error) {
      expect(error).toBeInstanceOf(FactoryError)
      expect((error as FactoryError).cause).toBe(cause)
      expect((error as FactoryError).path).toEqual(["flaky"])
    }
    expect(runtime.resolve(useFlaky)).toEqual({ calls: 2 })
    expect(runtime.resolve(useFlaky)).toBe(runtime.resolve(useFlaky))
    expect(calls).toBe(2)
    await runtime.dispose()
  })

  it("uses explicit child scope for nested callables even under other ambient", async () => {
    const runtime = createRuntime()
    const useConfig = runtime.defineSlot({
      name: "config",
      default: () => "root",
    })
    const useView = runtime.defineComputed(() => ({ config: useConfig() }), {
      name: "view",
    })
    const outer = runtime.createScope([provide(useConfig, "outer")])
    const child = runtime.createScope([provide(useConfig, "child")])

    expect(child.resolve(useView).config).toBe("child")
    expect(await outer.run(async () => child.resolve(useView).config)).toBe(
      "child",
    )

    await outer.close()
    await child.close()
    await runtime.dispose()
  })

  it("tracks explicit Runtime.resolve calls made by a factory", async () => {
    const runtime = createRuntime()
    const useConfig = runtime.defineSlot({
      name: "config",
      default: () => "root",
    })
    const useView = runtime.defineComputed(
      () => ({ config: runtime.resolve(useConfig) }),
      { name: "view" },
    )
    const child = runtime.createScope([provide(useConfig, "child")])

    expect(child.resolve(useView).config).toBe("child")
    await child.close()
    await runtime.dispose()
  })

  it("rejects arbitrary cross-scope resolve inside a factory", async () => {
    const runtime = createRuntime()
    const useValue = runtime.defineSlot({
      name: "value",
      default: () => "root",
    })
    const other = runtime.createScope()
    const useConsumer = runtime.defineComputed(() => other.resolve(useValue), {
      name: "consumer",
    })

    expect(() => runtime.resolve(useConsumer)).toThrow(
      CrossScopeResolutionError,
    )
    await other.close()
    await runtime.dispose()
  })

  it("rejects Scope management and lifecycle operations inside factories", async () => {
    const runtime = createRuntime()
    const closedInstallation = runtime.install([])
    await closedInstallation.close()
    const installation = runtime.install([])
    const scope = runtime.createScope()
    const operations: readonly [
      name: string,
      invoke: () => unknown,
      expectedOperation?: string,
    ][] = [
      ["Runtime.install", () => runtime.install([])],
      ["Runtime.createScope", () => runtime.createScope()],
      ["Runtime.withOverrides", () => runtime.withOverrides([], () => {})],
      ["Runtime.dispose", () => runtime.dispose()],
      ["Installation.close", () => installation.close()],
      [
        "Installation.close (closed)",
        () => closedInstallation.close(),
        "Installation.close",
      ],
      ["Scope.createScope", () => scope.createScope()],
      ["Scope.run", () => scope.run(() => {})],
      ["Scope.withOverrides", () => scope.withOverrides([], () => {})],
      ["Scope.retire", () => scope.retire()],
      ["Scope.close", () => scope.close()],
    ]

    for (const [name, invoke, expectedOperation = name] of operations) {
      const useConsumer = runtime.defineComputed(
        () => {
          invoke()
          return name
        },
        { name: `consumer:${name}` },
      )
      let error: unknown
      try {
        runtime.resolve(useConsumer)
      } catch (caught) {
        error = caught
      }
      expect(error).toBeInstanceOf(FactoryScopeOperationError)
      expect((error as FactoryScopeOperationError).operation).toBe(
        expectedOperation,
      )
      expect((error as FactoryScopeOperationError).dependencyName).toBe(
        `consumer:${name}`,
      )
    }

    await scope.close()
    await installation.close()
    await runtime.dispose()
  })

  it("localizes a value that caught a failed dependency read", async () => {
    const runtime = createRuntime()
    const useConfig = runtime.defineSlot({
      name: "config",
      default: () => "root",
    })
    const useFailing = runtime.defineComputed(
      () => {
        const config = useConfig()
        throw new Error(config)
      },
      { name: "failing" },
    )
    let fallbackCalls = 0
    const useFallback = runtime.defineComputed(
      () => {
        fallbackCalls += 1
        try {
          useFailing()
          return { value: "unreachable" }
        } catch (error) {
          return { value: deepestCauseMessage(error) }
        }
      },
      { name: "fallback" },
    )
    const child = runtime.createScope([provide(useConfig, "child")])
    const childValue = child.resolve(useFallback)
    const grandchild = child.createScope()
    const grandchildValue = grandchild.resolve(useFallback)

    expect(childValue.value).toBe("child")
    expect(child.resolve(useFallback)).toBe(childValue)
    expect(grandchildValue.value).toBe("child")
    expect(grandchildValue).not.toBe(childValue)
    await grandchild.close()
    await child.close()

    const rootValue = runtime.resolve(useFallback)
    expect(rootValue.value).toBe("root")
    expect(rootValue).not.toBe(childValue)
    expect(fallbackCalls).toBe(3)
    await runtime.dispose()
  })

  it("rematerializes a consumer when ancestor validation hits a new failure", async () => {
    const runtime = createRuntime()
    const useFailure = runtime.defineSlot({
      name: "failure",
      default: () => false,
    })
    const useDependency = runtime.defineComputed(
      () => {
        if (useFailure()) {
          throw new Error("child failure")
        }
        return "root success"
      },
      { name: "dependency" },
    )
    const useConsumer = runtime.defineComputed(
      () => {
        try {
          return { value: useDependency() }
        } catch (error) {
          return { value: deepestCauseMessage(error) }
        }
      },
      { name: "consumer" },
    )
    const rootValue = runtime.resolve(useConsumer)
    const child = runtime.createScope([provide(useFailure, true)])

    const childValue = child.resolve(useConsumer)
    expect(rootValue.value).toBe("root success")
    expect(childValue.value).toBe("child failure")
    expect(childValue).not.toBe(rootValue)

    await child.close()
    await runtime.dispose()
  })

  it("does not publish a consumer when a nested error escapes", async () => {
    const runtime = createRuntime()
    let consumerCalls = 0
    const useFailure = runtime.defineComputed(
      () => {
        throw new Error("failure")
      },
      { name: "failure" },
    )
    const useConsumer = runtime.defineComputed(
      () => {
        consumerCalls += 1
        return useFailure()
      },
      { name: "consumer" },
    )

    expect(() => runtime.resolve(useConsumer)).toThrow(FactoryError)
    expect(() => runtime.resolve(useConsumer)).toThrow(FactoryError)
    expect(consumerCalls).toBe(2)
    await runtime.dispose()
  })
})

describe("promotion", () => {
  it("promotes a cold unaffected resource to root ownership", async () => {
    const runtime = createRuntime()
    const useConfig = runtime.defineSlot({
      name: "config",
      default: () => "root",
    })
    const useUnrelated = runtime.defineSlot({
      name: "unrelated",
      default: () => "root",
    })
    let disposed = 0
    const useResource = runtime.defineResource(
      () => ({ config: useConfig() }),
      {
        name: "resource",
        dispose: () => {
          disposed += 1
        },
      },
    )
    const child = runtime.createScope([provide(useUnrelated, "child")])
    const value = child.resolve(useResource)

    await child.close()
    expect(disposed).toBe(0)
    expect(runtime.resolve(useResource)).toBe(value)
    await runtime.dispose()
    expect(disposed).toBe(1)
  })

  it("places cells at the deepest provider or dependency home", async () => {
    const runtime = createRuntime()
    const useConfig = runtime.defineSlot({
      name: "config",
      default: () => "root",
    })
    const useUnrelated = runtime.defineSlot({
      name: "unrelated",
      default: () => "root",
    })
    const useResource = runtime.defineResource(
      () => ({ config: useConfig() }),
      {
        name: "resource",
      },
    )
    const level1 = runtime.createScope([provide(useConfig, "level1")])
    const level2 = level1.createScope([provide(useUnrelated, "level2")])
    const value = level2.resolve(useResource)

    await level2.close()
    expect(level1.resolve(useResource)).toBe(value)

    const factoryScope = runtime.createScope([
      provideFactory(useResource, () => ({ config: "factory" })),
    ])
    const factoryValue = factoryScope.resolve(useResource)
    expect(factoryValue.config).toBe("factory")
    expect(factoryValue).not.toBe(runtime.resolve(useResource))

    await level1.close()
    await factoryScope.close()
    await runtime.dispose()
  })

  it("shares parent cells between compatible siblings", async () => {
    const runtime = createRuntime()
    const useConfig = runtime.defineSlot({
      name: "config",
      default: () => "root",
    })
    const useResource = runtime.defineResource(
      () => ({ config: useConfig() }),
      {
        name: "resource",
      },
    )
    const compatibleLeft = runtime.createScope()
    const compatibleRight = runtime.createScope()
    const conflictingLeft = runtime.createScope([provide(useConfig, "left")])
    const conflictingRight = runtime.createScope([provide(useConfig, "right")])

    expect(compatibleLeft.resolve(useResource)).toBe(
      compatibleRight.resolve(useResource),
    )
    expect(conflictingLeft.resolve(useResource)).not.toBe(
      conflictingRight.resolve(useResource),
    )

    await compatibleLeft.close()
    await compatibleRight.close()
    await conflictingLeft.close()
    await conflictingRight.close()
    await runtime.dispose()
  })

  it("creates a separate resource when a scope dependency changes", async () => {
    const runtime = createRuntime()
    const rootRequest = {}
    const useRequest = runtime.defineSlot({
      default: () => rootRequest,
    })
    let disposed = 0
    const useLocal = runtime.defineResource(() => ({ request: useRequest() }), {
      name: "local",
      dispose: () => {
        disposed += 1
      },
    })
    const rootValue = runtime.resolve(useLocal)
    const childRequest = {}
    const child = runtime.createScope([provide(useRequest, childRequest)])
    const childValue = child.resolve(useLocal)

    expect(childValue).not.toBe(rootValue)
    expect(rootValue.request).toBe(rootRequest)
    expect(childValue.request).toBe(childRequest)
    expect(child.resolve(useLocal)).toBe(childValue)
    await child.close()
    expect(disposed).toBe(1)
    await runtime.dispose()
    expect(disposed).toBe(2)
  })

  it("allows promotion into a retiring ancestor from its live child", async () => {
    const runtime = createRuntime()
    const useConfig = runtime.defineSlot<string>({ name: "config" })
    let disposed = 0
    const useResource = runtime.defineResource(
      () => ({ config: useConfig() }),
      {
        name: "resource",
        dispose: () => {
          disposed += 1
        },
      },
    )
    const parent = runtime.createScope([provide(useConfig, "parent")])
    const child = parent.createScope()
    const retirement = parent.retire()

    const value = child.resolve(useResource)
    expect(value.config).toBe("parent")
    await child.close()
    await retirement
    expect(disposed).toBe(1)
    await runtime.dispose()
  })
})

function deepestCauseMessage(error: unknown): string {
  let current = error
  while (
    current instanceof Error &&
    "cause" in current &&
    current.cause !== undefined
  ) {
    current = current.cause
  }
  return current instanceof Error ? current.message : String(current)
}
