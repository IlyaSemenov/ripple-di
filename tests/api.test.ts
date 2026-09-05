import { afterAll, describe, expect, expectTypeOf, it } from "bun:test"

import {
  asValue,
  collectProvisions,
  createDetachedStream,
  createOverrideRunner,
  createRuntime,
  createScope,
  createValueOverride,
  type Dependency,
  type DetachedStream,
  defineDependency,
  defineFactoryDependency,
  dispose,
  type FactoryDependency,
  type Installation,
  install,
  MissingProviderError,
  memo,
  memoize,
  type OverrideRunner,
  OwnedProvisionReuseError,
  type Provision,
  type ProvisionCollectionInput,
  provide,
  provideFactory,
  resolve,
  runDetached,
  type Scope,
  type ValueOverride,
  withOverrides,
  withoutProvider,
} from "ripple-di"

import { createQueryBuilder, type QueryBuilder } from "./awaitable"

const useConfig = defineDependency(() => ({ url: "production" }))
const useDatabaseLabel = defineDependency(() => `db:${useConfig().url}`)
const useDb = defineDependency(() => {
  const config = useConfig()
  return {
    url: config.url,
    query: async () => `rows from ${config.url}`,
  }
})
type Db = ReturnType<typeof useDb>

interface Closeable {
  close(): void
}

type Handler = () => string

afterAll(() => dispose())

describe("consumer site", () => {
  async function consumer() {
    const db = useDb()
    return await db.query()
  }

  it("supports the normative callable consumer site", async () => {
    expect(await consumer()).toBe("rows from production")
  })

  it("uses one callable for ambient read, provision, and explicit resolve", async () => {
    const fake: Db = {
      url: "fake",
      query: async () => "fake rows",
    }
    await withOverrides([provide(useDb, fake)], (scope) => {
      const viaCall: Db = useDb()
      const viaResolve: Db = scope.resolve(useDb)
      expect(viaCall).toBe(fake)
      expect(viaResolve).toBe(fake)
    })
  })

  it("exposes no token mutation API or enumerable metadata", () => {
    expect(Object.keys(useDb)).toEqual([])
    expect("get" in useDb).toBe(false)
    expect("set" in useDb).toBe(false)
    expect("reset" in useDb).toBe(false)
    expect("setFactory" in useDb).toBe(false)
    expect("provide" in useDb).toBe(false)
  })

  it("accepts dependencies and factory dependencies as provider removals", async () => {
    const useValue = defineDependency(() => 42)
    const format = defineFactoryDependency((value: number) => String(value))
    expectTypeOf(withoutProvider(useValue)).toEqualTypeOf<Provision>()
    expectTypeOf(withoutProvider(format)).toEqualTypeOf<Provision>()
    await withOverrides(
      collectProvisions(withoutProvider(useValue), withoutProvider(format)),
      () => {
        expect(() => useValue()).toThrow(MissingProviderError)
        expect(() => format(42)).toThrow(MissingProviderError)
      },
    )
    expect(useValue()).toBe(42)
    expect(format(42)).toBe("42")
    // @ts-expect-error Only a dependency token can be removed.
    expect(() => withoutProvider(() => 42)).toThrow(TypeError)
  })
})

describe("dependency-aware memo types", () => {
  it("preserves getter, method, receiver, and result types", () => {
    class Example {
      @memo
      get label(): string {
        return "label"
      }

      @memo
      count(): number {
        return 1
      }
    }

    const tracked = memoize(function (this: Example): string {
      return this.label
    })
    const standalone = memoize(() => 42)
    const example = new Example()

    expectTypeOf(example.label).toEqualTypeOf<string>()
    expectTypeOf(example.count).toEqualTypeOf<() => number>()
    expectTypeOf(tracked).toEqualTypeOf<(this: Example) => string>()
    expectTypeOf(standalone).toEqualTypeOf<() => number>()
    expect(tracked.call(example)).toBe("label")
    expect(standalone()).toBe(42)
  })
})

describe("factory dependency", () => {
  it("contextually types a built-in factory from its explicit signature", () => {
    const trim = defineFactoryDependency<(value: string) => string>((value) => {
      expectTypeOf(value).toEqualTypeOf<string>()
      return value.trim()
    })

    expectTypeOf(trim).toEqualTypeOf<
      FactoryDependency<(value: string) => string>
    >()
    expect(trim(" value ")).toBe("value")
  })

  it("contextually types a runtime factory from its explicit signature", async () => {
    const runtime = createRuntime()
    const trim = runtime.defineFactoryDependency<(value: string) => string>(
      (value) => {
        expectTypeOf(value).toEqualTypeOf<string>()
        return value.trim()
      },
    )

    expectTypeOf(trim).toEqualTypeOf<
      FactoryDependency<(value: string) => string>
    >()
    expect(trim(" value ")).toBe("value")
    await runtime.dispose()
  })

  it("defines a factory slot without a built-in implementation", async () => {
    type LoadContext = (bucket: string) => Promise<{ bucket: string }>
    const LoadContext = defineFactoryDependency<LoadContext>()

    expectTypeOf(LoadContext).toEqualTypeOf<FactoryDependency<LoadContext>>()
    expect(() => LoadContext("assets")).toThrow(MissingProviderError)

    await withOverrides(
      provide(LoadContext, async (bucket) => ({ bucket })),
      async () => {
        await expect(LoadContext("assets")).resolves.toEqual({
          bucket: "assets",
        })
      },
    )
  })

  it("resolves the current factory and preserves its receiver", async () => {
    const defaultFactory = function (this: { prefix: string }, value: number) {
      return `${this.prefix}:${value}`
    }
    const Format = defineFactoryDependency(defaultFactory)
    const replacement = function (this: { prefix: string }, value: number) {
      return `${this.prefix}:${value * 2}`
    }

    expect(Format.call({ prefix: "default" }, 2)).toBe("default:2")
    expect(resolve(Format)).toBe(defaultFactory)

    const scope = createScope()
    expect(scope.resolve(Format)).toBe(defaultFactory)
    await scope.close()

    await withOverrides(provide(Format, replacement), () => {
      expect(Format.call({ prefix: "override" }, 2)).toBe("override:4")
      expect(resolve(Format)).toBe(replacement)
    })
    await withOverrides(
      provideFactory(Format, () => replacement),
      () => {
        expect(Format.call({ prefix: "factory" }, 3)).toBe("factory:6")
      },
    )
  })

  it("preserves optional, rest, async, void, generic, and overloaded signatures", () => {
    const queryFactory = (
      sql: string,
      params?: readonly unknown[],
    ): Promise<{ sql: string; params: readonly unknown[] | undefined }> =>
      Promise.resolve({ sql, params })
    const Query = defineFactoryDependency(queryFactory)
    const Count = defineFactoryDependency(
      (...values: string[]) => values.length,
    )
    const Notify = defineFactoryDependency((_message: string): void => {})
    const Identity = defineFactoryDependency(<T>(value: T): T => value)
    function Convert(value: string): number
    function Convert(value: number): string
    function Convert(value: string | number): string | number {
      return typeof value === "string" ? value.length : String(value)
    }
    const ConvertValue = defineFactoryDependency(Convert)

    expectTypeOf(Query).toEqualTypeOf<FactoryDependency<typeof queryFactory>>()
    expectTypeOf<Parameters<typeof Query>>().toEqualTypeOf<
      [sql: string, params?: readonly unknown[]]
    >()
    expectTypeOf<ReturnType<typeof Query>>().toEqualTypeOf<
      Promise<{
        sql: string
        params: readonly unknown[] | undefined
      }>
    >()
    expectTypeOf(resolve(Query)).toEqualTypeOf<typeof queryFactory>()
    expectTypeOf(Count("a", "b")).toEqualTypeOf<number>()
    expectTypeOf(Notify("done")).toEqualTypeOf<void>()
    expectTypeOf(Identity({ id: 1 })).toEqualTypeOf<{ id: number }>()
    expectTypeOf(ConvertValue("1")).toEqualTypeOf<number>()
    expectTypeOf(ConvertValue(1)).toEqualTypeOf<string>()
  })

  it("does not cache invocation results and isolates parallel overrides", async () => {
    const Create = defineFactoryDependency((label: string) => ({ label }))

    expect(Create("same")).not.toBe(Create("same"))

    const [left, right] = await Promise.all([
      withOverrides(
        provide(Create, (label) => ({ label: `A:${label}` })),
        async () => {
          await Promise.resolve()
          return Create("x")
        },
      ),
      withOverrides(
        provide(Create, (label) => ({ label: `B:${label}` })),
        async () => {
          await Promise.resolve()
          return Create("x")
        },
      ),
    ])

    expect(left).toEqual({ label: "A:x" })
    expect(right).toEqual({ label: "B:x" })
  })
})

describe("module-level API", () => {
  it("exports global counterparts for runtime methods", async () => {
    expect(resolve(useDb)).toBe(useDb())
    expect(resolve(useDatabaseLabel)).toBe("db:production")

    const scope = createScope([provide(useConfig, { url: "manual" })])
    expect(scope.run(() => useDb().url)).toBe("manual")
    // @ts-expect-error Scope ancestry is internal.
    expect(scope.parent).toBeUndefined()
    await scope.close()
  })

  it("installs application-wide providers through the module-level API", async () => {
    const useInstalledConfig = defineDependency<{ url: string }>({
      name: "installed-config",
    })
    const installation: Installation = install([
      provide(useInstalledConfig, { url: "installed" }),
    ])

    expect(useInstalledConfig().url).toBe("installed")
    await withOverrides(
      [provide(useInstalledConfig, { url: "scoped" })],
      () => {
        expect(useInstalledConfig().url).toBe("scoped")
      },
    )
    expect(useInstalledConfig().url).toBe("installed")

    await installation.close()
    expect(() => useInstalledConfig()).toThrow(MissingProviderError)
  })

  it("exposes detached streams through the module-level API", async () => {
    const stream: DetachedStream<number> = createDetachedStream(
      async function* (scope) {
        expectTypeOf(scope).toEqualTypeOf<Scope>()
        yield 42
      },
    )
    const values: number[] = []

    for await (const value of stream) {
      expectTypeOf(value).toEqualTypeOf<number>()
      values.push(value)
    }

    expect(values).toEqual([42])
  })

  it("exposes detached context through the module-level API", async () => {
    const result: Promise<number> = runDetached(async (scope) => {
      expectTypeOf(scope).toEqualTypeOf<Scope>()
      await Promise.resolve()
      return 42
    })

    expect(await result).toBe(42)
  })
})

describe("provision input", () => {
  it("collects individual, listed, and conditional provisions", () => {
    const useValue = defineDependency<string>({ name: "collected-value" })
    const value = provide(useValue, "value")
    const inputs: ProvisionCollectionInput[] = [
      value,
      [value],
      false,
      null,
      undefined,
    ]
    const collected = collectProvisions(...inputs)

    expectTypeOf(collected).toEqualTypeOf<readonly Provision[]>()
    expect(collected).toEqual([value, value])
    // @ts-expect-error Other falsy values are invalid provision inputs.
    collectProvisions(0)
  })

  it("installs several listed and conditional provision inputs", async () => {
    const useHost = defineDependency<string>({ name: "host" })
    const usePort = defineDependency<number>({ name: "port" })
    const installation = install(
      provide(useHost, "localhost"),
      false,
      [provide(usePort, 3000)],
      null,
      undefined,
    )

    expect(`${useHost()}:${usePort()}`).toBe("localhost:3000")
    await installation.close()
  })

  it("takes one provision without an array wherever provisions are supplied", async () => {
    const useValue = defineDependency<string>({ name: "single-value" })
    const useLayer = defineDependency<string>({ name: "single-layer" })
    const installation = install(provide(useValue, "installed"))

    expect(useValue()).toBe("installed")
    await withOverrides(provide(useValue, "overridden"), async (scope) => {
      expect(useValue()).toBe("overridden")
      await scope.withOverrides(provide(useValue, "nested"), () => {
        expect(useValue()).toBe("nested")
      })
      const child = scope.createScope(provide(useValue, "child"))
      expect(child.resolve(useValue)).toBe("child")
      await child.close()
    })

    const scope = createScope(provide(useValue, "manual"))
    expect(scope.resolve(useValue)).toBe("manual")
    await scope.close()

    const runner = createOverrideRunner(() => provide(useValue, "runner"))
    const layered = runner.extend(() => provide(useLayer, "layer"))
    expect(await runner.run(() => useValue())).toBe("runner")
    expect(await layered.run(() => `${useValue()}/${useLayer()}`)).toBe(
      "runner/layer",
    )

    await installation.close()
  })

  it("takes one provision through the runtime methods too", async () => {
    const runtime = createRuntime()
    const useValue = runtime.defineDependency<string>({ name: "single-value" })
    runtime.install(provide(useValue, "installed"))

    const scoped = await runtime.withOverrides(
      provide(useValue, "overridden"),
      (scope) => scope.resolve(useValue),
    )
    const scope = runtime.createScope(provide(useValue, "manual"))

    expect(scoped).toBe("overridden")
    expect(scope.resolve(useValue)).toBe("manual")

    await scope.close()
    await runtime.dispose()
  })

  it("owns a single handed-over provision like a list of one", async () => {
    const closed: string[] = []
    const useConnection = defineDependency<{ id: string }>({
      name: "connection",
      dispose: (connection) => void closed.push(connection.id),
    })
    const handover = provide(useConnection, { id: "solo" }, { dispose: true })

    await withOverrides(handover, () => {
      expect(useConnection().id).toBe("solo")
    })

    expect(closed).toEqual(["solo"])
    await expect(withOverrides(handover, () => {})).rejects.toThrow(
      OwnedProvisionReuseError,
    )
  })
})

describe("override runner", () => {
  const useCaller = defineDependency<string>({ name: "caller" })
  const callers: OverrideRunner = createOverrideRunner(() => [
    provide(useCaller, "caller"),
  ])

  it("reuses one set of overrides for separate calls", async () => {
    const useTenant = defineDependency<string>({ name: "tenant" })
    const tenants = callers.extend(() => [provide(useTenant, "acme")])

    expect(await callers.run(() => useCaller())).toBe("caller")
    expect(await tenants.run(async () => `${useCaller()}/${useTenant()}`)).toBe(
      "caller/acme",
    )

    const call = callers.run(() => useDb())
    expectTypeOf(call).toEqualTypeOf<Promise<Db>>()
    expectTypeOf(tenants).toEqualTypeOf<OverrideRunner>()
    expect((await call).url).toBe("production")
  })

  it(
    "runs a wrapped function as the case callback",
    callers.wrap(async () => {
      expect(useCaller()).toBe("caller")
    }),
  )

  it("infers the arguments, receiver, and result of a wrapped function", async () => {
    const repeatLater = callers.wrap(async (label: string, times: number) =>
      `${useCaller()}:${label}`.repeat(times),
    )
    const countNow = callers.wrap((...parts: string[]) => parts.length)
    const describeMethod = callers.wrap(function (
      this: { prefix: string },
      count: number,
    ) {
      return `${this.prefix}${count}`
    })

    expectTypeOf(repeatLater).toEqualTypeOf<
      (label: string, times: number) => Promise<string>
    >()
    expectTypeOf(countNow).toEqualTypeOf<
      (...parts: string[]) => Promise<number>
    >()
    // A declared receiver survives wrapping, so calling it wrongly is rejected.
    expectTypeOf<ThisParameterType<typeof describeMethod>>().toEqualTypeOf<{
      prefix: string
    }>()
    expectTypeOf<ReturnType<typeof describeMethod>>().toEqualTypeOf<
      Promise<string>
    >()

    expect(await repeatLater("a", 2)).toBe("caller:acaller:a")
    expect(await countNow("a", "b")).toBe(2)
    expect(await describeMethod.call({ prefix: "service" }, 1)).toBe("service1")
  })
})

describe("type inference", () => {
  async function loadToken() {
    return "token"
  }

  it("keeps provide and provideFactory distinct for function values", async () => {
    const useHandler = defineDependency<Handler>()
    await withOverrides([provide(useHandler, () => "value")], () => {
      expect(useHandler()()).toBe("value")
    })
    await withOverrides(
      [provideFactory(useHandler, () => () => "factory")],
      () => {
        expect(useHandler()()).toBe("factory")
      },
    )
  })

  it("infers every defineDependency form", () => {
    const useUnknown = defineDependency()
    const useNamedUnknown = defineDependency({ name: "unknown" })
    const useRequired = defineDependency<Closeable>()
    const useRequiredWithDisposer = defineDependency({
      dispose: (value: Closeable) => value.close(),
    })
    const useCreated = defineDependency(() => ({ close() {} }), {
      dispose: (value) => value.close(),
    })
    const useDisposable = defineDependency(() => ({ [Symbol.dispose]() {} }), {
      dispose: true,
    })
    const useFunction = defineDependency((): (() => string) => () => "value")
    const useAlias = defineDependency(useConfig)
    const namedFactory = (() => ({ close() {} })) as (() => Closeable) & {
      readonly name: string
    }
    const factoryWithDisposeProperty = (() => ({
      close() {},
    })) as (() => Closeable) & {
      readonly dispose: (value: Closeable) => void
    }
    const useNamedFactory = defineDependency(namedFactory)
    const useFactoryWithDisposeProperty = defineDependency(
      factoryWithDisposeProperty,
    )

    expectTypeOf(useUnknown).toEqualTypeOf<Dependency<unknown>>()
    expectTypeOf(useNamedUnknown).toEqualTypeOf<Dependency<unknown>>()
    expectTypeOf(useRequired).toEqualTypeOf<Dependency<Closeable>>()
    expectTypeOf(useRequiredWithDisposer).toEqualTypeOf<Dependency<Closeable>>()
    expectTypeOf(useCreated).toEqualTypeOf<Dependency<{ close(): void }>>()
    expectTypeOf(useDisposable).toEqualTypeOf<Dependency<Disposable>>()
    expectTypeOf(useFunction).toEqualTypeOf<Dependency<() => string>>()
    expectTypeOf(useAlias).toEqualTypeOf<
      Dependency<ReturnType<typeof useConfig>>
    >()
    expectTypeOf(useNamedFactory).toEqualTypeOf<Dependency<Closeable>>()
    expectTypeOf(useFactoryWithDisposeProperty).toEqualTypeOf<
      Dependency<Closeable>
    >()
  })

  it("types lifecycle handles as asynchronously disposable", () => {
    expectTypeOf<Scope>().toMatchTypeOf<AsyncDisposable>()
    expectTypeOf<Installation>().toMatchTypeOf<AsyncDisposable>()
    expectTypeOf<
      ReturnType<typeof createRuntime>
    >().toMatchTypeOf<AsyncDisposable>()
  })

  it("awaits every callback form", async () => {
    const readLabel = (): string | Promise<string> => "label"

    const syncCall = withOverrides([], () => 1)
    const asyncCall = withOverrides([], async () => "value")
    const unionCall = withOverrides([], readLabel)
    const thenableCall = withOverrides([], () => createQueryBuilder("callback"))
    const voidCall = withOverrides([], () => {})

    expectTypeOf(syncCall).toEqualTypeOf<Promise<number>>()
    expectTypeOf(asyncCall).toEqualTypeOf<Promise<string>>()
    expectTypeOf(unionCall).toEqualTypeOf<Promise<string>>()
    expectTypeOf(thenableCall).toEqualTypeOf<Promise<string[]>>()
    expectTypeOf(voidCall).toEqualTypeOf<Promise<void>>()

    expect(await syncCall).toBe(1)
    expect(await asyncCall).toBe("value")
    expect(await unionCall).toBe("label")
    expect(await thenableCall).toEqual(["rows from callback"])
    expect(await voidCall).toBeUndefined()
  })

  it("awaits the callback result of every scoped API", async () => {
    // A callback whose sync and async results differ needs the awaited result
    // type of each API, so any of them losing it fails to type-check.
    const countOrLoad = (): number | Promise<string> => 1
    const runtime = createRuntime()
    const scope = createScope()
    const runner = createOverrideRunner(() => [])

    const globalCall = withOverrides([], countOrLoad)
    const runtimeCall = runtime.withOverrides([], countOrLoad)
    const globalDetachedCall = runDetached(countOrLoad)
    const runtimeDetachedCall = runtime.runDetached(countOrLoad)
    const scopeCall = scope.withOverrides([], countOrLoad)
    const runCall = runner.run(countOrLoad)
    const wrapped = runner.wrap(countOrLoad)
    // Only the scoped callbacks are awaited; run returns its result unchanged.
    const thenableRun = scope.run(() => createQueryBuilder("callback"))
    const globalStream = createDetachedStream(async function* () {
      yield 1
    })
    const runtimeStream = runtime.createDetachedStream(async function* () {
      yield "value"
    })

    expectTypeOf(globalCall).toEqualTypeOf<Promise<number | string>>()
    expectTypeOf(runtimeCall).toEqualTypeOf<Promise<number | string>>()
    expectTypeOf(globalDetachedCall).toEqualTypeOf<Promise<number | string>>()
    expectTypeOf(runtimeDetachedCall).toEqualTypeOf<Promise<number | string>>()
    expectTypeOf(scopeCall).toEqualTypeOf<Promise<number | string>>()
    expectTypeOf(runCall).toEqualTypeOf<Promise<number | string>>()
    expectTypeOf(wrapped).toEqualTypeOf<() => Promise<number | string>>()
    expectTypeOf(thenableRun).toEqualTypeOf<QueryBuilder>()
    expectTypeOf(globalStream).toEqualTypeOf<DetachedStream<number>>()
    expectTypeOf(runtimeStream).toEqualTypeOf<DetachedStream<string>>()

    expect(await globalCall).toBe(1)
    expect(await runtimeCall).toBe(1)
    expect(await globalDetachedCall).toBe(1)
    expect(await runtimeDetachedCall).toBe(1)
    expect(await scopeCall).toBe(1)
    expect(await runCall).toBe(1)
    expect(await wrapped()).toBe(1)
    expect(await thenableRun).toEqual(["rows from callback"])

    await globalStream[Symbol.asyncDispose]()
    await runtimeStream[Symbol.asyncDispose]()
    await scope.close()
    await runtime.dispose()
  })

  it("infers a value override helper", async () => {
    const useHandler = defineDependency<Handler>()
    const withDb = createValueOverride(useDb, { dispose: (db) => void db.url })
    const withHandler = createValueOverride(useHandler)
    const fake: Db = { url: "fake", query: async () => "fake rows" }

    const countOrLoad = (): number | Promise<string> => 1
    const counted = withDb(fake, () => 1)
    const loaded = withDb(fake, async (scope) => scope.resolve(useDb).url)
    const mixed = withDb(fake, countOrLoad)
    const handled = withHandler(
      () => "handled",
      () => useHandler()(),
    )

    expectTypeOf(withDb).toEqualTypeOf<ValueOverride<Db>>()
    expectTypeOf(withHandler).toEqualTypeOf<ValueOverride<Handler>>()
    expectTypeOf<Parameters<ValueOverride<Db>>[0]>().toEqualTypeOf<Db>()
    expectTypeOf(counted).toEqualTypeOf<Promise<number>>()
    expectTypeOf(loaded).toEqualTypeOf<Promise<string>>()
    expectTypeOf(mixed).toEqualTypeOf<Promise<number | string>>()
    expectTypeOf(handled).toEqualTypeOf<Promise<string>>()
    withDb(fake, (scope) => {
      expectTypeOf(scope).toEqualTypeOf<Scope>()
    })

    expect(await counted).toBe(1)
    expect(await loaded).toBe("fake")
    expect(await mixed).toBe(1)
    expect(await handled).toBe("handled")
  })

  it("infers awaitable values without unwrapping them", async () => {
    const useQueryBuilder = defineDependency(
      () => createQueryBuilder("infer"),
      {
        dispose: (builder) => void builder.url,
      },
    )
    const useToken = defineDependency(() => asValue(loadToken()))

    expectTypeOf(useQueryBuilder).toEqualTypeOf<Dependency<QueryBuilder>>()
    expectTypeOf(useQueryBuilder()).toEqualTypeOf<QueryBuilder>()
    expectTypeOf(useToken).toEqualTypeOf<Dependency<Promise<string>>>()

    expect(useQueryBuilder().url).toBe("infer")
    expect(await useQueryBuilder()).toEqual(["rows from infer"])
    expect(await useToken()).toBe("token")

    await withOverrides(
      [
        provideFactory(useQueryBuilder, () => createQueryBuilder("override")),
        provideFactory(useToken, () => asValue(loadToken())),
      ],
      async () => {
        expect(useQueryBuilder().url).toBe("override")
        expect(await useToken()).toBe("token")
      },
    )
  })
})

describe("invalid consumer syntax", () => {
  it("rejects every statement below at compile time", () => {
    const handlerValue: Handler = () => "value"
    const useStringDependency = defineDependency(() => "value")

    // @ts-expect-error Config cannot be provided as a number.
    provide(useConfig, 123)
    // @ts-expect-error Db requires query().
    provide(useDb, { url: "invalid" })
    // @ts-expect-error A built-in value must be supplied through a factory.
    defineDependency<{ value: number }>({ value: 1 })
    // @ts-expect-error Dependency options have no label field.
    defineDependency<string>({ label: "value" })
    // @ts-expect-error A function value needs an outer factory.
    defineDependency<Handler>(handlerValue)
    // @ts-expect-error An alias factory must return the requested value type.
    defineDependency<number>(useStringDependency)
    // @ts-expect-error A disposer receives the factory result type.
    defineDependency(() => ({ close() {} }), {
      dispose: (value: string) => value.length,
    })
    // @ts-expect-error A value override disposes the value of its dependency.
    createValueOverride(useConfig, { dispose: (value: string) => value.length })
    // @ts-expect-error Factory dependency options do not own invocation results.
    defineFactoryDependency(() => "value", { dispose: () => {} })
    // @ts-expect-error Dependency-aware memos do not accept arguments.
    memoize((_value: string) => "value")

    class InvalidMemoMethods {
      // @ts-expect-error A memoized method cannot have required arguments.
      @memo
      required(_value: string) {}

      // @ts-expect-error A memoized method cannot have optional arguments.
      @memo
      optional(_value?: string) {}

      // @ts-expect-error A memoized method cannot have rest arguments.
      @memo
      rest(..._values: string[]) {}
    }

    void InvalidMemoMethods
  })
})
