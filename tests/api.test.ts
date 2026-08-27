import { afterAll, describe, expect, expectTypeOf, it } from "bun:test"

import {
  asValue,
  createOverrideRunner,
  createRuntime,
  createScope,
  createValueOverride,
  type Dependency,
  defineDependency,
  dispose,
  type Installation,
  install,
  MissingProviderError,
  type OverrideRunner,
  OwnedProvisionReuseError,
  provide,
  provideFactory,
  resolve,
  type Scope,
  type ValueOverride,
  withDetachedContext,
  withDetachedOverrides,
  withOverrides,
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

  it("exposes detached overrides through the module-level API", async () => {
    const result: Promise<number> = withDetachedOverrides([], async (scope) => {
      expectTypeOf(scope).toEqualTypeOf<Scope>()
      await Promise.resolve()
      return 42
    })

    expect(await result).toBe(42)
  })

  it("exposes detached context through the module-level API", async () => {
    const result: Promise<number> = withDetachedContext(async (scope) => {
      expectTypeOf(scope).toEqualTypeOf<Scope>()
      await Promise.resolve()
      return 42
    })

    expect(await result).toBe(42)
  })
})

describe("provision input", () => {
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
    expectTypeOf(useFunction).toEqualTypeOf<Dependency<() => string>>()
    expectTypeOf(useAlias).toEqualTypeOf<
      Dependency<ReturnType<typeof useConfig>>
    >()
    expectTypeOf(useNamedFactory).toEqualTypeOf<Dependency<Closeable>>()
    expectTypeOf(useFactoryWithDisposeProperty).toEqualTypeOf<
      Dependency<Closeable>
    >()
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
    const globalDetachedCall = withDetachedContext(countOrLoad)
    const runtimeDetachedCall = runtime.withDetachedContext(countOrLoad)
    const scopeCall = scope.withOverrides([], countOrLoad)
    const runCall = runner.run(countOrLoad)
    const wrapped = runner.wrap(countOrLoad)
    // Only the scoped callbacks are awaited; run returns its result unchanged.
    const thenableRun = scope.run(() => createQueryBuilder("callback"))

    expectTypeOf(globalCall).toEqualTypeOf<Promise<number | string>>()
    expectTypeOf(runtimeCall).toEqualTypeOf<Promise<number | string>>()
    expectTypeOf(globalDetachedCall).toEqualTypeOf<Promise<number | string>>()
    expectTypeOf(runtimeDetachedCall).toEqualTypeOf<Promise<number | string>>()
    expectTypeOf(scopeCall).toEqualTypeOf<Promise<number | string>>()
    expectTypeOf(runCall).toEqualTypeOf<Promise<number | string>>()
    expectTypeOf(wrapped).toEqualTypeOf<() => Promise<number | string>>()
    expectTypeOf(thenableRun).toEqualTypeOf<QueryBuilder>()

    expect(await globalCall).toBe(1)
    expect(await runtimeCall).toBe(1)
    expect(await globalDetachedCall).toBe(1)
    expect(await runtimeDetachedCall).toBe(1)
    expect(await scopeCall).toBe(1)
    expect(await runCall).toBe(1)
    expect(await wrapped()).toBe(1)
    expect(await thenableRun).toEqual(["rows from callback"])

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
  })
})
