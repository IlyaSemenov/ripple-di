import { describe, expect, it } from "bun:test"
import vm from "node:vm"

import type { Dependency } from "ripple-di"
import {
  AsyncFactoryError,
  asValue,
  CrossScopeResolutionError,
  createRuntime,
  DependencyCycleError,
  defineDependency,
  FactoryError,
  FactoryScopeOperationError,
  MissingProviderError,
  memoize,
  provide,
  provideFactory,
  withoutProvider,
} from "ripple-di"

import { createQueryBuilder, type QueryBuilder } from "./awaitable"

// Distinctive successful value for the branch that avoids the test cycle.
const NON_CYCLIC_VALUE = 42
const ANONYMOUS_DIAGNOSTIC_NAME =
  /^dependency#\d+ \(tests\/resolution\.test\.ts:\d+\)$/

describe("resolution and tracking", () => {
  it("reports a missing provider", async () => {
    const runtime = createRuntime()
    const useMissing = runtime.defineDependency<string>({ name: "missing" })
    const useMiddle = runtime.defineDependency(() => useMissing(), {
      name: "middle",
    })
    const useOuter = runtime.defineDependency(() => useMiddle(), {
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

  it("generates a diagnostic name for an anonymous dependency", async () => {
    const runtime = createRuntime()
    const useAnonymous = runtime.defineDependency<string>()

    let error: unknown
    try {
      runtime.resolve(useAnonymous)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(MissingProviderError)
    expect((error as MissingProviderError).dependencyName).toMatch(
      ANONYMOUS_DIAGNOSTIC_NAME,
    )
    expect((error as MissingProviderError).path).toEqual([
      (error as MissingProviderError).dependencyName,
    ])
    await runtime.dispose()
  })

  it("uses a named factory unless an explicit name takes priority", async () => {
    const runtime = createRuntime()
    function namedFactory(): never {
      throw new Error("named failure")
    }
    const useNamedFactory = runtime.defineDependency(namedFactory)
    const useExplicitName = runtime.defineDependency(namedFactory, {
      name: "explicit",
    })

    expect(() => runtime.resolve(useNamedFactory)).toThrow(
      'Factory for dependency "namedFactory" failed',
    )
    expect(() => runtime.resolve(useExplicitName)).toThrow(
      'Factory for dependency "explicit" failed',
    )
    await runtime.dispose()
  })

  it("keeps anonymous definition sites through a resolution chain", async () => {
    const runtime = createRuntime()
    const useMissing = runtime.defineDependency<string>()
    const useMiddle = runtime.defineDependency(() => useMissing())
    const useOuter = runtime.defineDependency(() => useMiddle())

    let error: unknown
    try {
      runtime.resolve(useOuter)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(MissingProviderError)
    const missingError = error as MissingProviderError
    expect(missingError.dependencyName).toMatch(ANONYMOUS_DIAGNOSTIC_NAME)
    expect(missingError.path).toHaveLength(3)
    for (const dependencyName of missingError.path) {
      expect(dependencyName).toMatch(ANONYMOUS_DIAGNOSTIC_NAME)
    }
    await runtime.dispose()
  })

  it("keeps anonymous definition sites in dependency cycles", async () => {
    const runtime = createRuntime()
    let useEntry!: Dependency<number>
    let useReturn!: Dependency<number>
    useEntry = runtime.defineDependency(() => useReturn())
    useReturn = runtime.defineDependency(() => useEntry())

    let error: unknown
    try {
      runtime.resolve(useEntry)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(DependencyCycleError)
    const path = (error as DependencyCycleError).path
    expect(path).toHaveLength(3)
    expect(path[0]).toBe(path[2])
    expect(path[0]).toMatch(ANONYMOUS_DIAGNOSTIC_NAME)
    expect(path[1]).toMatch(ANONYMOUS_DIAGNOSTIC_NAME)
    await runtime.dispose()
  })

  it("reports a global default factory at its definition site", () => {
    const cause = new Error("global failure")
    const useFailure = defineDependency(() => {
      throw cause
    })

    let error: unknown
    try {
      useFailure()
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(FactoryError)
    const factoryError = error as FactoryError
    expect(factoryError.dependencyName).toMatch(ANONYMOUS_DIAGNOSTIC_NAME)
    expect(factoryError.path).toEqual([factoryError.dependencyName])
    expect(factoryError.cause).toBe(cause)
  })

  it("reports an override factory with the dependency definition site", async () => {
    const runtime = createRuntime()
    const cause = new Error("override failure")
    const useOverride = runtime.defineDependency<string>()
    const scope = runtime.createScope(
      provideFactory(useOverride, () => {
        throw cause
      }),
    )

    let error: unknown
    try {
      scope.resolve(useOverride)
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(FactoryError)
    const factoryError = error as FactoryError
    expect(factoryError.dependencyName).toMatch(ANONYMOUS_DIAGNOSTIC_NAME)
    expect(factoryError.path).toEqual([factoryError.dependencyName])
    expect(factoryError.cause).toBe(cause)
    await scope.close()
    await runtime.dispose()
  })

  it("evaluates factories lazily once and caches undefined", async () => {
    const runtime = createRuntime()
    let calls = 0
    const useValue = runtime.defineDependency(
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
    const useHandler = runtime.defineDependency<() => string>({
      name: "handler",
    })
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

  it("does not run the built-in factory behind a direct override", async () => {
    const runtime = createRuntime()
    let calls = 0
    const useValue = runtime.defineDependency(
      () => {
        calls += 1
        return "default"
      },
      { name: "value" },
    )
    const scope = runtime.createScope([provide(useValue, "override")])

    expect(scope.resolve(useValue)).toBe("override")
    expect(calls).toBe(0)
    await scope.close()
    await runtime.dispose()
  })

  it("uses nearest overrides and preserves the exact parent identity", async () => {
    const runtime = createRuntime()
    const useConfig = runtime.defineDependency(() => "root", {
      name: "config",
    })
    const useView = runtime.defineDependency(() => ({ config: useConfig() }), {
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
    const useConfig = runtime.defineDependency<object>({ name: "config" })
    const useView = runtime.defineDependency(() => ({ config: useConfig() }), {
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
    const useFlag = runtime.defineDependency(() => true, { name: "flag" })
    const useLeft = runtime.defineDependency(() => "left", { name: "left" })
    const useRight = runtime.defineDependency(() => "right", { name: "right" })
    const useChoice = runtime.defineDependency(
      () => ({ value: useFlag() ? useLeft() : useRight() }),
      { name: "choice" },
    )
    const useOuter = runtime.defineDependency(() => ({ choice: useChoice() }), {
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

  it("tracks factory invocation reads on the active consumer branch", async () => {
    const runtime = createRuntime()
    const useA = runtime.defineDependency(() => "A", { name: "A" })
    const useB = runtime.defineDependency(() => "B", { name: "B" })
    const Foo = runtime.defineFactoryDependency(
      (flag: boolean) => (flag ? useA() : useB()),
      { name: "Foo" },
    )
    const useLeft = runtime.defineDependency(() => ({ value: Foo(true) }), {
      name: "left",
    })
    const useRight = runtime.defineDependency(() => ({ value: Foo(false) }), {
      name: "right",
    })
    const rootLeft = runtime.resolve(useLeft)
    const rootRight = runtime.resolve(useRight)
    const overrideA = runtime.createScope(provide(useA, "override-A"))
    const overrideB = runtime.createScope(provide(useB, "override-B"))
    const overrideFoo = runtime.createScope(
      provide(Foo, (flag) => (flag ? "override-left" : "override-right")),
    )

    expect(overrideA.resolve(useLeft)).toEqual({ value: "override-A" })
    expect(overrideA.resolve(useLeft)).not.toBe(rootLeft)
    expect(overrideA.resolve(useRight)).toBe(rootRight)
    expect(overrideB.resolve(useLeft)).toBe(rootLeft)
    expect(overrideB.resolve(useRight)).toEqual({ value: "override-B" })
    expect(overrideB.resolve(useRight)).not.toBe(rootRight)
    expect(overrideFoo.resolve(useLeft)).toEqual({ value: "override-left" })
    expect(overrideFoo.resolve(useLeft)).not.toBe(rootLeft)
    expect(overrideFoo.resolve(useRight)).toEqual({ value: "override-right" })
    expect(overrideFoo.resolve(useRight)).not.toBe(rootRight)

    await overrideA.close()
    await overrideB.close()
    await overrideFoo.close()
    await runtime.dispose()
  })

  it("detects a complete cycle but ignores an inactive conditional cycle", async () => {
    const runtime = createRuntime()
    let useA!: Dependency<number>
    let useB!: Dependency<number>
    useA = runtime.defineDependency(() => useB(), { name: "A" })
    useB = runtime.defineDependency(() => useA(), { name: "B" })
    const useFlag = runtime.defineDependency(() => false, { name: "flag" })
    let useConditional!: Dependency<number>
    useConditional = runtime.defineDependency(
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
    const useAsync = runtime.defineDependency(() => Promise.resolve("value"), {
      name: "async",
    })
    const useAsyncFunction = runtime.defineDependency(
      async () => await Promise.resolve("value"),
      { name: "async-function" },
    )
    const useChained = runtime.defineDependency(
      () => Promise.resolve("value").then((text) => text.toUpperCase()),
      { name: "chained" },
    )
    const useForeignRealm = runtime.defineDependency(
      () => vm.runInNewContext("Promise.resolve('value')") as Promise<string>,
      { name: "foreign-realm" },
    )

    expect(() => runtime.resolve(useAsync)).toThrow(AsyncFactoryError)
    expect(() => runtime.resolve(useAsyncFunction)).toThrow(AsyncFactoryError)
    expect(() => runtime.resolve(useChained)).toThrow(AsyncFactoryError)
    // A promise from another realm fails `instanceof Promise`.
    expect(vm.runInNewContext("Promise.resolve(1)") instanceof Promise).toBe(
      false,
    )
    expect(() => runtime.resolve(useForeignRealm)).toThrow(AsyncFactoryError)
    await runtime.dispose()
  })

  it("resolves an awaitable value as an ordinary value", async () => {
    const runtime = createRuntime()
    const useConfig = runtime.defineDependency(() => "production", {
      name: "config",
    })
    const useRegion = runtime.defineDependency(() => "eu", { name: "region" })
    let disposed: QueryBuilder | undefined
    const useQueryBuilder = runtime.defineDependency(
      () => createQueryBuilder(useConfig()),
      {
        name: "query-builder",
        dispose: (builder) => {
          disposed = builder
        },
      },
    )

    const builder = runtime.resolve(useQueryBuilder)
    expect(builder.url).toBe("production")
    expect(runtime.resolve(useQueryBuilder)).toBe(builder)
    expect(await builder).toEqual(["rows from production"])

    const unrelated = runtime.createScope([provide(useRegion, "us")])
    expect(unrelated.resolve(useQueryBuilder)).toBe(builder)
    await unrelated.close()
    expect(disposed).toBeUndefined()

    const scope = runtime.createScope([provide(useConfig, "tenant")])
    const scopedBuilder = scope.resolve(useQueryBuilder)
    expect(scopedBuilder).not.toBe(builder)
    expect(scopedBuilder.url).toBe("tenant")
    await scope.close()
    expect(disposed).toBe(scopedBuilder)

    await runtime.dispose()
    expect(disposed).toBe(builder)
  })

  it("resolves an awaitable value from an override factory", async () => {
    const runtime = createRuntime()
    const useQueryBuilder = runtime.defineDependency<QueryBuilder>({
      name: "query-builder",
    })
    const scope = runtime.createScope([
      provideFactory(useQueryBuilder, () => createQueryBuilder("override")),
    ])

    const builder = scope.resolve(useQueryBuilder)
    expect(builder.url).toBe("override")
    expect(scope.resolve(useQueryBuilder)).toBe(builder)

    await scope.close()
    await runtime.dispose()
  })

  it("resolves a value that only claims to be a promise", async () => {
    const runtime = createRuntime()
    const disguised = {
      // biome-ignore lint/suspicious/noThenProperty: the disguise is the subject under test.
      then: (resolve: (value: string) => void) => resolve("resolved"),
      [Symbol.toStringTag]: "Promise",
    }
    const useDisguised = runtime.defineDependency(() => disguised, {
      name: "disguised",
    })

    expect(runtime.resolve(useDisguised)).toBe(disguised)
    await runtime.dispose()
  })

  it("keeps a promise as the value when the factory marks it", async () => {
    const runtime = createRuntime()
    const useConfig = runtime.defineDependency(() => "production", {
      name: "config",
    })
    let calls = 0
    const disposedTokens: unknown[] = []
    const useToken = runtime.defineDependency(
      () => {
        calls += 1
        const config = useConfig()
        return asValue(Promise.resolve(`token for ${config}`))
      },
      {
        name: "token",
        dispose: (token) => {
          disposedTokens.push(token)
        },
      },
    )

    const token = runtime.resolve(useToken)
    expect(runtime.resolve(useToken)).toBe(token)
    expect(await token).toBe("token for production")
    expect(calls).toBe(1)

    const scope = runtime.createScope([provide(useConfig, "tenant")])
    const scopedToken = scope.resolve(useToken)
    expect(await scopedToken).toBe("token for tenant")
    expect(calls).toBe(2)

    // The disposer receives the promise itself rather than the marker.
    await scope.close()
    expect(disposedTokens).toHaveLength(1)
    expect(disposedTokens[0]).toBe(scopedToken)
    await runtime.dispose()
    expect(disposedTokens).toHaveLength(2)
    expect(disposedTokens[1]).toBe(token)
  })

  it("keeps a marked promise from an override factory", async () => {
    const runtime = createRuntime()
    const useToken = runtime.defineDependency<Promise<string>>({
      name: "token",
    })
    const scope = runtime.createScope([
      provideFactory(useToken, () => asValue(Promise.resolve("override"))),
    ])

    expect(await scope.resolve(useToken)).toBe("override")
    await scope.close()
    await runtime.dispose()
  })

  it("wraps user errors with cause/path and retries them", async () => {
    const runtime = createRuntime()
    const cause = new Error("boom")
    let calls = 0
    const useFlaky = runtime.defineDependency(
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
    const useConfig = runtime.defineDependency(() => "root", {
      name: "config",
    })
    const useView = runtime.defineDependency(() => ({ config: useConfig() }), {
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
    const useConfig = runtime.defineDependency(() => "root", {
      name: "config",
    })
    const useView = runtime.defineDependency(
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
    const useValue = runtime.defineDependency(() => "root", {
      name: "value",
    })
    const other = runtime.createScope()
    const useConsumer = runtime.defineDependency(
      () => other.resolve(useValue),
      {
        name: "consumer",
      },
    )

    expect(() => runtime.resolve(useConsumer)).toThrow(
      CrossScopeResolutionError,
    )
    await other.close()
    await runtime.dispose()
  })

  it("rejects scope management and lifecycle operations inside factories", async () => {
    const runtime = createRuntime()
    const closedInstallation = runtime.install([])
    await closedInstallation.close()
    const installation = runtime.install([])
    const scope = runtime.createScope()
    const runner = runtime.createOverrideRunner(() => [])
    const useOverridden = runtime.defineDependency<object>({
      name: "overridden",
    })
    const overrideValue = runtime.createValueOverride(useOverridden)
    const operations: readonly [
      name: string,
      invoke: () => unknown,
      expectedOperation?: string,
    ][] = [
      ["Runtime.install", () => runtime.install([])],
      ["Runtime.createScope", () => runtime.createScope()],
      ["Runtime.withOverrides", () => runtime.withOverrides([], () => {})],
      [
        "Runtime.withDetachedOverrides",
        () => runtime.withDetachedOverrides([], () => {}),
      ],
      [
        "Runtime.withDetachedContext",
        () => runtime.withDetachedContext(() => {}),
      ],
      ["OverrideRunner.run", () => runner.run(() => {})],
      ["ValueOverride", () => overrideValue({}, () => {})],
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
      const useConsumer = runtime.defineDependency(
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
    const useConfig = runtime.defineDependency(() => "root", {
      name: "config",
    })
    const useFailing = runtime.defineDependency(
      () => {
        const config = useConfig()
        throw new Error(config)
      },
      { name: "failing" },
    )
    let fallbackCalls = 0
    const useFallback = runtime.defineDependency(
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
    const useFailure = runtime.defineDependency(() => false, {
      name: "failure",
    })
    const useDependency = runtime.defineDependency(
      () => {
        if (useFailure()) {
          throw new Error("child failure")
        }
        return "root success"
      },
      { name: "dependency" },
    )
    const useConsumer = runtime.defineDependency(
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
    const useFailure = runtime.defineDependency(
      () => {
        throw new Error("failure")
      },
      { name: "failure" },
    )
    const useConsumer = runtime.defineDependency(
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

  it("blocks cached fallback values and rebuilds consumers with the real error path", async () => {
    const runtime = createRuntime()
    const disposed: string[] = []
    let tenantCalls = 0
    let serviceCalls = 0
    const useTenant = runtime.defineDependency(
      () => {
        tenantCalls += 1
        return "tenant"
      },
      {
        name: "tenant",
        dispose: (tenant) => {
          disposed.push(tenant)
        },
      },
    )
    const useService = runtime.defineDependency(
      () => {
        serviceCalls += 1
        return { tenant: useTenant() }
      },
      { name: "service" },
    )
    const useHandler = runtime.defineDependency(
      () => ({ service: useService() }),
      { name: "handler" },
    )
    const useDb = runtime.defineDependency(() => ({}))
    const handler = useHandler()
    const db = useDb()
    const tenantMemo = memoize(() => useTenant())
    expect(tenantMemo()).toBe("tenant")

    await runtime.withOverrides(withoutProvider(useTenant), (scope) => {
      expect(() => scope.resolve(useTenant)).toThrow(MissingProviderError)
      expect(() => tenantMemo()).toThrow(MissingProviderError)
      expect(() => useHandler()).toThrow(
        new MissingProviderError("tenant", ["handler", "service", "tenant"]),
      )
      expect(useDb()).toBe(db)
    })

    expect(serviceCalls).toBeGreaterThan(1)
    expect(tenantCalls).toBe(1)
    expect(disposed).toEqual([])
    expect(useHandler()).toBe(handler)
    expect(tenantMemo()).toBe("tenant")
    await runtime.dispose()
    expect(disposed).toEqual(["tenant"])
  })

  it("does not call an unread fallback or parent override factory", async () => {
    const runtime = createRuntime()
    let calls = 0
    const factory = () => ++calls
    const useValue = runtime.defineDependency(factory)
    const removal = withoutProvider(useValue)

    await runtime.withOverrides(removal, () => {
      expect(() => useValue()).toThrow(MissingProviderError)
    })
    await runtime.withOverrides(provideFactory(useValue, factory), () =>
      runtime.withOverrides(removal, () => {
        expect(() => useValue()).toThrow(MissingProviderError)
      }),
    )
    expect(calls).toBe(0)
    await runtime.dispose()
  })

  it("keeps values that handle a blocked read local to their scope", async () => {
    const runtime = createRuntime()
    const useTenant = runtime.defineDependency(() => "tenant")
    const useOptional = runtime.defineDependency(() => {
      try {
        return { tenant: useTenant() }
      } catch (error) {
        if (!(error instanceof MissingProviderError)) throw error
        return { tenant: undefined }
      }
    })
    const original = useOptional()
    await runtime.withOverrides(withoutProvider(useTenant), async () => {
      const anonymous = useOptional()
      expect(anonymous.tenant).toBeUndefined()
      await runtime.withOverrides([], () => {
        expect(useOptional()).not.toBe(anonymous)
      })
      await runtime.withOverrides(provide(useTenant, "child"), () => {
        expect(useOptional().tenant).toBe("child")
      })
      expect(useOptional()).toBe(anonymous)
    })
    expect(useOptional()).toBe(original)
    await runtime.dispose()
  })
})

describe("promotion", () => {
  it("promotes a cold unaffected factory value to root ownership", async () => {
    const runtime = createRuntime()
    const useConfig = runtime.defineDependency(() => "root", {
      name: "config",
    })
    const useUnrelated = runtime.defineDependency(() => "root", {
      name: "unrelated",
    })
    let disposed = 0
    const useFactoryValue = runtime.defineDependency(
      () => ({ config: useConfig() }),
      {
        name: "factory-value",
        dispose: () => {
          disposed += 1
        },
      },
    )
    const child = runtime.createScope([provide(useUnrelated, "child")])
    const value = child.resolve(useFactoryValue)

    await child.close()
    expect(disposed).toBe(0)
    expect(runtime.resolve(useFactoryValue)).toBe(value)
    await runtime.dispose()
    expect(disposed).toBe(1)
  })

  it("places cells at the deepest provider or dependency home", async () => {
    const runtime = createRuntime()
    const useConfig = runtime.defineDependency(() => "root", {
      name: "config",
    })
    const useUnrelated = runtime.defineDependency(() => "root", {
      name: "unrelated",
    })
    const useFactoryValue = runtime.defineDependency(
      () => ({ config: useConfig() }),
      {
        name: "factory-value",
      },
    )
    const level1 = runtime.createScope([provide(useConfig, "level1")])
    const level2 = level1.createScope([provide(useUnrelated, "level2")])
    const value = level2.resolve(useFactoryValue)

    await level2.close()
    expect(level1.resolve(useFactoryValue)).toBe(value)

    const factoryScope = runtime.createScope([
      provideFactory(useFactoryValue, () => ({ config: "factory" })),
    ])
    const factoryValue = factoryScope.resolve(useFactoryValue)
    expect(factoryValue.config).toBe("factory")
    expect(factoryValue).not.toBe(runtime.resolve(useFactoryValue))

    await level1.close()
    await factoryScope.close()
    await runtime.dispose()
  })

  it("shares parent cells between compatible siblings", async () => {
    const runtime = createRuntime()
    const useConfig = runtime.defineDependency(() => "root", {
      name: "config",
    })
    const useFactoryValue = runtime.defineDependency(
      () => ({ config: useConfig() }),
      {
        name: "factory-value",
      },
    )
    const compatibleLeft = runtime.createScope()
    const compatibleRight = runtime.createScope()
    const conflictingLeft = runtime.createScope([provide(useConfig, "left")])
    const conflictingRight = runtime.createScope([provide(useConfig, "right")])

    expect(compatibleLeft.resolve(useFactoryValue)).toBe(
      compatibleRight.resolve(useFactoryValue),
    )
    expect(conflictingLeft.resolve(useFactoryValue)).not.toBe(
      conflictingRight.resolve(useFactoryValue),
    )

    await compatibleLeft.close()
    await compatibleRight.close()
    await conflictingLeft.close()
    await conflictingRight.close()
    await runtime.dispose()
  })

  it("creates a separate factory value when a scope dependency changes", async () => {
    const runtime = createRuntime()
    const rootRequest = {}
    const useRequest = runtime.defineDependency(() => rootRequest)
    let disposed = 0
    const useLocal = runtime.defineDependency(
      () => ({ request: useRequest() }),
      {
        name: "local",
        dispose: () => {
          disposed += 1
        },
      },
    )
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
    const useConfig = runtime.defineDependency<string>({ name: "config" })
    let disposed = 0
    const useFactoryValue = runtime.defineDependency(
      () => ({ config: useConfig() }),
      {
        name: "factory-value",
        dispose: () => {
          disposed += 1
        },
      },
    )
    const parent = runtime.createScope([provide(useConfig, "parent")])
    const child = parent.createScope()
    const retirement = parent.retire()

    const value = child.resolve(useFactoryValue)
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
