import { expect, it } from "bun:test"

import {
  createRuntime,
  CrossRuntimeDependencyError,
  memoize,
  provide,
  provideFactory,
} from "ripple-di"

it("lists every input nearest first with the path that leads to it", () => {
  const runtime = createRuntime()
  const useTenant = runtime.defineDependency(() => "tenant", { name: "tenant" })
  const useConfig = runtime.defineDependency(() => "config", { name: "config" })
  const useQueryBuilder = runtime.defineDependency(() => ({ config: useConfig() }), {
    name: "query-builder",
  })
  // A callback that a library calls while the factory runs is tracked too.
  const callLibrary = (callback: () => string) => callback()
  const useDb = runtime.defineDependency(
    () => ({ builder: useQueryBuilder(), tenant: callLibrary(() => useTenant()) }),
    { name: "db" },
  )

  expect(runtime.inspectDependency(useDb).inputs).toEqual([
    { dependency: useQueryBuilder, name: "query-builder", path: ["db", "query-builder"] },
    { dependency: useTenant, name: "tenant", path: ["db", "tenant"] },
    { dependency: useConfig, name: "config", path: ["db", "query-builder", "config"] },
  ])
})

it("reports each input once through its shortest path", () => {
  const runtime = createRuntime()
  const useConfig = runtime.defineDependency(() => "config", { name: "config" })
  const useLabel = runtime.defineDependency(() => useConfig(), { name: "label" })
  const useReport = runtime.defineDependency(() => [useLabel(), useConfig()], {
    name: "report",
  })

  expect(runtime.inspectDependency(useReport).inputs.map(input => input.path)).toEqual([
    ["report", "label"],
    ["report", "config"],
  ])
})

it("lists no inputs for a provided value", async () => {
  const runtime = createRuntime()
  const useConfig = runtime.defineDependency(() => "config", { name: "config" })
  const useLabel = runtime.defineDependency(() => useConfig(), { name: "label" })

  await runtime.withOverrides(provide(useLabel, "provided"), () => {
    expect(runtime.inspectDependency(useLabel).inputs).toEqual([])
  })
})

it("inspects the value of the current scope and builds it when missing", async () => {
  const runtime = createRuntime()
  const useConfig = runtime.defineDependency(() => "config", { name: "config" })
  const useClock = runtime.defineDependency(() => 0, { name: "clock" })
  let built = 0
  const useLabel = runtime.defineDependency(
    () => {
      built += 1
      return useConfig()
    },
    { name: "label" },
  )

  expect(runtime.inspectDependency(useLabel).inputs.map(input => input.name)).toEqual(["config"])
  expect(built).toBe(1)

  await runtime.withOverrides(
    provideFactory(useLabel, () => String(useClock())),
    () => {
      expect(runtime.inspectDependency(useLabel).inputs.map(input => input.name)).toEqual(["clock"])
    },
  )
  expect(built).toBe(1)
})

it("lists the inputs that a memo computation read for the factory", () => {
  const runtime = createRuntime()
  const useConfig = runtime.defineDependency(() => "config", { name: "config" })
  const readConfig = memoize(() => useConfig())
  const useLabel = runtime.defineDependency(() => readConfig(), { name: "label" })

  expect(runtime.inspectDependency(useLabel).inputs.map(input => input.name)).toEqual(["config"])
})

it("tracks the inspected dependency as an input of the calling factory", async () => {
  const runtime = createRuntime()
  const useConfig = runtime.defineDependency(() => "root", { name: "config" })
  const useLabel = runtime.defineDependency(() => useConfig(), { name: "label" })
  const useInputNames = runtime.defineDependency(
    () => runtime.inspectDependency(useLabel).inputs.map(input => input.name),
    { name: "input-names" },
  )

  const rootNames = runtime.resolve(useInputNames)
  expect(rootNames).toEqual(["config"])
  // Walking the inputs of label adds no reads of its own to the factory.
  expect(runtime.inspectDependency(useInputNames).inputs.map(input => input.path)).toEqual([
    ["input-names", "label"],
    ["input-names", "label", "config"],
  ])
  await runtime.withOverrides(provide(useLabel, "provided"), () => {
    expect(runtime.resolve(useInputNames)).toEqual([])
  })
})

it("rejects a dependency of another runtime", () => {
  const runtime = createRuntime()
  const other = createRuntime()
  const useForeign = other.defineDependency(() => "foreign")

  expect(() => runtime.inspectDependency(useForeign)).toThrow(CrossRuntimeDependencyError)
})
