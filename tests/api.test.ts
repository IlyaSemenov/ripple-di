import { afterAll, expect, expectTypeOf, it } from "bun:test"

import {
  asValue,
  createOverrideRunner,
  createScope,
  type Dependency,
  defineDependency,
  dispose,
  type Installation,
  install,
  MissingProviderError,
  type OverrideRunner,
  provide,
  provideFactory,
  resolve,
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

async function consumer() {
  const db = useDb()
  return await db.query()
}

it("supports the normative callable consumer site", async () => {
  expect(await consumer()).toBe("rows from production")
})

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
  await withOverrides([provide(useInstalledConfig, { url: "scoped" })], () => {
    expect(useInstalledConfig().url).toBe("scoped")
  })
  expect(useInstalledConfig().url).toBe("installed")

  await installation.close()
  expect(() => useInstalledConfig()).toThrow(MissingProviderError)
})

it("reuses one set of overrides for separate calls", async () => {
  const useCaller = defineDependency<string>({ name: "caller" })
  const useTenant = defineDependency<string>({ name: "tenant" })
  const callers: OverrideRunner = createOverrideRunner(() => [
    provide(useCaller, "caller"),
  ])
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

it("keeps provide and provideFactory distinct for function values", async () => {
  const useHandler = defineDependency<() => string>()
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

it("infers awaitable values without unwrapping them", async () => {
  const useQueryBuilder = defineDependency(() => createQueryBuilder("infer"), {
    dispose: (builder) => void builder.url,
  })
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

async function loadToken() {
  return "token"
}

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
