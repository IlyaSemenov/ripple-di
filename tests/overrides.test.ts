import { describe, expect, it } from "bun:test"

import {
  CrossRuntimeDependencyError,
  createRuntime,
  LeakedChildScopeError,
  MissingProviderError,
  OwnedProvisionReuseError,
  provide,
  type Scope,
  ScopeClosedError,
} from "ripple-di"

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

// A short timer forces a real async context switch without slowing the suite.
const ASYNC_CONTEXT_DELAY_MS = 5

describe("override runner", () => {
  it("builds new provisions and a new scope for every call", async () => {
    const runtime = createRuntime()
    const useSession = runtime.defineDependency<{ id: number }>({
      name: "session",
    })
    const useRequest = runtime.defineDependency(
      () => ({ session: useSession() }),
      { name: "request" },
    )
    const disposed: number[] = []
    let nextSessionId = 1
    const sessions = runtime.createOverrideRunner(() => [
      provide(
        useSession,
        { id: nextSessionId++ },
        {
          dispose: (session) => {
            disposed.push(session.id)
          },
        },
      ),
    ])

    const first = await sessions.run(() => useRequest())
    const second = await sessions.run((scope) => scope.resolve(useRequest))

    expect(first.session.id).toBe(1)
    expect(second.session.id).toBe(2)
    expect(disposed).toEqual([1, 2])
    expect(() => useSession()).toThrow(MissingProviderError)
    await runtime.dispose()
  })

  it("rejects a provision list shared between calls", async () => {
    const runtime = createRuntime()
    const useSession = runtime.defineDependency<object>({ name: "session" })
    const shared = [provide(useSession, {}, { dispose: () => {} })]
    const sessions = runtime.createOverrideRunner(() => shared)

    await sessions.run(() => {})
    await expect(sessions.run(() => {})).rejects.toThrow(
      OwnedProvisionReuseError,
    )
    await runtime.dispose()
  })

  it("requires a factory instead of a fixed provision list", () => {
    const runtime = createRuntime()
    const useSession = runtime.defineDependency<object>({ name: "session" })

    expect(() =>
      runtime.createOverrideRunner([provide(useSession, {})] as never),
    ).toThrow(TypeError)
  })

  it("isolates concurrent calls", async () => {
    const runtime = createRuntime()
    const useTenant = runtime.defineDependency<string>({ name: "tenant" })
    let nextTenant = 1
    const tenants = runtime.createOverrideRunner(() => [
      provide(useTenant, `tenant-${nextTenant++}`),
    ])

    const [slow, fast] = await Promise.all([
      tenants.run(async () => {
        await delay(ASYNC_CONTEXT_DELAY_MS)
        return useTenant()
      }),
      tenants.run(() => useTenant()),
    ])

    expect(slow).toBe("tenant-1")
    expect(fast).toBe("tenant-2")
    await runtime.dispose()
  })

  it("recreates only the values built from the overrides", async () => {
    const runtime = createRuntime()
    const useClock = runtime.defineDependency(() => ({ now: () => 0 }), {
      name: "clock",
    })
    const useConfig = runtime.defineDependency<string>({ name: "config" })
    const useDb = runtime.defineDependency(() => ({ url: useConfig() }), {
      name: "db",
    })
    let nextConfig = 1
    const configs = runtime.createOverrideRunner(() => [
      provide(useConfig, `config-${nextConfig++}`),
    ])
    const read = () => configs.run(() => ({ db: useDb(), clock: useClock() }))

    const first = await read()
    const second = await read()

    expect(first.db).not.toBe(second.db)
    expect(second.db.url).toBe("config-2")
    expect(first.clock).toBe(second.clock)
    await runtime.dispose()
  })

  it("applies extended overrides on top of the runner they extend", async () => {
    const runtime = createRuntime()
    const useLabel = runtime.defineDependency<string>({ name: "label" })
    const useTenant = runtime.defineDependency<string>({ name: "tenant" })
    const sessions = runtime.createOverrideRunner(() => [
      provide(useLabel, "session"),
    ])
    const tenants = sessions.extend(() => [
      provide(useLabel, "tenant-session"),
      provide(useTenant, "acme"),
    ])

    expect(await tenants.run(() => `${useLabel()}/${useTenant()}`)).toBe(
      "tenant-session/acme",
    )
    expect(await sessions.run(() => useLabel())).toBe("session")
    await expect(sessions.run(() => useTenant())).rejects.toThrow(
      MissingProviderError,
    )
    await runtime.dispose()
  })

  it("rebuilds every layer per call and unwinds them inside out", async () => {
    const runtime = createRuntime()
    const useSession = runtime.defineDependency<object>({ name: "session" })
    const useTenant = runtime.defineDependency<object>({ name: "tenant" })
    const disposed: string[] = []
    const sessions = runtime.createOverrideRunner(() => [
      provide(
        useSession,
        {},
        {
          dispose: () => {
            disposed.push("session")
          },
        },
      ),
    ])
    const tenants = sessions.extend(() => [
      provide(
        useTenant,
        {},
        {
          dispose: () => {
            disposed.push("tenant")
          },
        },
      ),
    ])
    const read = () =>
      tenants.run(() => ({ session: useSession(), tenant: useTenant() }))

    const first = await read()
    const second = await read()

    expect(second.session).not.toBe(first.session)
    expect(second.tenant).not.toBe(first.tenant)
    expect(disposed).toEqual(["tenant", "session", "tenant", "session"])
    await runtime.dispose()
  })

  it("rejects instead of throwing when a provision factory fails", async () => {
    const runtime = createRuntime()
    const failure = new Error("provisions")
    const broken = runtime.createOverrideRunner(() => {
      throw failure
    })

    // A synchronous throw here would fail the test before the assertion.
    const call = broken.run(() => "unreachable")

    await expect(call).rejects.toBe(failure)
    await runtime.dispose()
  })

  it("cleans up entered layers when a later factory fails", async () => {
    const runtime = createRuntime()
    const useSession = runtime.defineDependency<object>({ name: "session" })
    const failure = new Error("tenant provisions")
    let disposed = 0
    const sessions = runtime.createOverrideRunner(() => [
      provide(
        useSession,
        {},
        {
          dispose: () => {
            disposed += 1
          },
        },
      ),
    ])
    const tenants = sessions.extend(() => {
      throw failure
    })

    await expect(tenants.run(() => {})).rejects.toBe(failure)
    expect(disposed).toBe(1)
    await runtime.dispose()
  })

  it("preserves callback, leak, and cleanup errors of every layer", async () => {
    const runtime = createRuntime()
    const useSession = runtime.defineDependency<object>({ name: "session" })
    const useTenant = runtime.defineDependency<object>({ name: "tenant" })
    const sessions = runtime.createOverrideRunner(() => [
      provide(
        useSession,
        {},
        {
          dispose: () => {
            throw new Error("session cleanup")
          },
        },
      ),
    ])
    const tenants = sessions.extend(() => [
      provide(
        useTenant,
        {},
        {
          dispose: () => {
            throw new Error("tenant cleanup")
          },
        },
      ),
    ])
    const failure = new Error("handler")

    const error = await tenants
      .run((scope) => {
        scope.createScope()
        throw failure
      })
      .then(
        () => undefined,
        (reason) => reason as AggregateError,
      )

    // Every layer reports its own failures, so the layer that was extended
    // aggregates the failure of the layer it entered.
    expect(error).toBeInstanceOf(AggregateError)
    expect(error?.errors).toHaveLength(2)
    const [tenantFailure, sessionCleanup] = error?.errors ?? []
    expect(tenantFailure).toBeInstanceOf(AggregateError)
    expect((sessionCleanup as Error).message).toBe("session cleanup")

    const tenantErrors = (tenantFailure as AggregateError).errors
    expect(tenantErrors).toContain(failure)
    expect(
      tenantErrors.some((item) => item instanceof LeakedChildScopeError),
    ).toBe(true)
    expect(
      tenantErrors.some(
        (item) => item instanceof Error && item.message === "tenant cleanup",
      ),
    ).toBe(true)
    await runtime.dispose()
  })

  it("overrides the current scope without leaving it", async () => {
    const runtime = createRuntime()
    const useRegion = runtime.defineDependency<string>({ name: "region" })
    const useLabel = runtime.defineDependency<string>({ name: "label" })
    const labels = runtime.createOverrideRunner(() => [
      provide(useLabel, "inner"),
    ])
    const scope = runtime.createScope([
      provide(useRegion, "eu"),
      provide(useLabel, "outer"),
    ])

    const label = await scope.run(() =>
      labels.run(() => `${useRegion()}/${useLabel()}`),
    )

    expect(label).toBe("eu/inner")
    expect(scope.resolve(useLabel)).toBe("outer")
    await scope.close()
    await runtime.dispose()
  })

  it("propagates a callback failure after cleaning the call up", async () => {
    const runtime = createRuntime()
    const useSession = runtime.defineDependency<object>({ name: "session" })
    let disposed = 0
    const sessions = runtime.createOverrideRunner(() => [
      provide(
        useSession,
        {},
        {
          dispose: () => {
            disposed += 1
          },
        },
      ),
    ])
    const failure = new Error("handler")

    await expect(
      sessions.run(() => {
        throw failure
      }),
    ).rejects.toBe(failure)
    expect(disposed).toBe(1)
    await runtime.dispose()
  })

  it("reports child scopes leaked by a call", async () => {
    const runtime = createRuntime()
    let leaked: Scope | undefined

    const error = await runtime
      .createOverrideRunner(() => [])
      .run((scope) => {
        leaked = scope.createScope()
      })
      .then(
        () => undefined,
        (reason) => reason,
      )

    expect(error).toBeInstanceOf(LeakedChildScopeError)
    expect(() => leaked?.createScope()).toThrow(ScopeClosedError)
    await runtime.dispose()
  })

  it("rejects provisions from another runtime", async () => {
    const runtime = createRuntime({ name: "application" })
    const other = createRuntime({ name: "other" })
    const useForeign = other.defineDependency<string>({ name: "foreign" })
    const foreign = runtime.createOverrideRunner(() => [
      provide(useForeign, "value"),
    ])

    await expect(foreign.run(() => {})).rejects.toThrow(
      CrossRuntimeDependencyError,
    )
    await other.dispose()
    await runtime.dispose()
  })
})
