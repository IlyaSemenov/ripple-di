import { afterAll, expect, it } from "bun:test"

import {
  createScope,
  defineComputed,
  defineResource,
  defineSlot,
  dispose,
  provide,
  provideFactory,
  resolve,
  withOverrides,
} from "ripple-di"

const useConfig = defineResource(() => ({ url: "production" }))
const useDatabaseLabel = defineComputed(() => `db:${useConfig().url}`)
const useDb = defineResource(() => {
  const config = useConfig()
  return {
    url: config.url,
    query: async () => `rows from ${config.url}`,
  }
})
type Db = ReturnType<typeof useDb>

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
  await scope.close()
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
  const useHandler = defineSlot<() => string>()
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

// @ts-expect-error Config cannot be provided as a number.
provide(useConfig, 123)
// @ts-expect-error Db requires query().
provide(useDb, { url: "invalid" })
