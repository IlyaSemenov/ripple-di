import { describe, expect, it } from "bun:test"

import {
  CrossRuntimeDependencyError,
  createRuntime,
  createValueOverride,
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
  it("requires a factory instead of a fixed provision list", () => {
    const runtime = createRuntime()
    const useSession = runtime.defineDependency<object>({ name: "session" })

    expect(() =>
      runtime.createOverrideRunner([provide(useSession, {})] as never),
    ).toThrow(TypeError)
  })

  describe("run", () => {
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
  })

  describe("wrap", () => {
    it("runs one call of its own per invocation", async () => {
      const runtime = createRuntime()
      const useSession = runtime.defineDependency<{ id: number }>({
        name: "session",
      })
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
      const readSession = sessions.wrap(
        (suffix: string) => useSession().id + suffix,
      )

      expect(await readSession("a")).toBe("1a")
      expect(await readSession("b")).toBe("2b")
      expect(disposed).toEqual([1, 2])
      expect(() => useSession()).toThrow(MissingProviderError)
      await runtime.dispose()
    })

    it("keeps the arguments and the receiver", async () => {
      const runtime = createRuntime()
      const useLabel = runtime.defineDependency<string>({ name: "label" })
      const labels = runtime.createOverrideRunner(() => [
        provide(useLabel, "scoped"),
      ])
      const service = {
        prefix: "service",
        describe: labels.wrap(function (this: { prefix: string }, ...parts) {
          return [this.prefix, useLabel(), ...parts].join("/")
        }),
      }

      expect(await service.describe("first", "second")).toBe(
        "service/scoped/first/second",
      )
      await runtime.dispose()
    })

    it("creates nothing before the first call", async () => {
      const runtime = createRuntime()
      const wrapped = runtime
        .createOverrideRunner(() => [])
        .wrap(() => "called")

      // An installation rejects live scopes, so an early scope would fail here.
      const installation = runtime.install([])

      expect(await wrapped()).toBe("called")
      await installation.close()
      await runtime.dispose()
    })

    it("isolates concurrent calls", async () => {
      const runtime = createRuntime()
      const useTenant = runtime.defineDependency<string>({ name: "tenant" })
      let nextTenant = 1
      const tenants = runtime.createOverrideRunner(() => [
        provide(useTenant, `tenant-${nextTenant++}`),
      ])
      const read = tenants.wrap(async (milliseconds: number) => {
        await delay(milliseconds)
        return useTenant()
      })

      const [slow, fast] = await Promise.all([
        read(ASYNC_CONTEXT_DELAY_MS),
        read(0),
      ])

      expect(slow).toBe("tenant-1")
      expect(fast).toBe("tenant-2")
      await runtime.dispose()
    })

    it("rejects and cleans up a failing call", async () => {
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
      const failing = sessions.wrap(() => {
        throw failure
      })

      await expect(failing()).rejects.toBe(failure)
      expect(disposed).toBe(1)
      await runtime.dispose()
    })
  })

  describe("extend", () => {
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
  })
})

describe("value override", () => {
  it("supplies the value to sync and async callbacks", async () => {
    const runtime = createRuntime()
    const useClient = runtime.defineDependency<{ id: string }>({
      name: "client",
    })
    const withClient = runtime.createValueOverride(useClient)

    const direct = await withClient({ id: "direct" }, () => useClient().id)
    const delayed = await withClient({ id: "delayed" }, async (scope) => {
      await delay(ASYNC_CONTEXT_DELAY_MS)
      return `${useClient().id}/${scope.resolve(useClient).id}`
    })

    expect(direct).toBe("direct")
    expect(delayed).toBe("delayed/delayed")
    expect(() => runtime.resolve(useClient)).toThrow(MissingProviderError)
    await runtime.dispose()
  })

  it("keeps a function value a value instead of a factory", async () => {
    const runtime = createRuntime()
    const useHandler = runtime.defineDependency<() => string>({
      name: "handler",
    })
    const withHandler = runtime.createValueOverride(useHandler)

    expect(
      await withHandler(
        () => "handled",
        () => useHandler()(),
      ),
    ).toBe("handled")
    await runtime.dispose()
  })

  it("isolates concurrent calls", async () => {
    const runtime = createRuntime()
    const useTenant = runtime.defineDependency<string>({ name: "tenant" })
    const withTenant = runtime.createValueOverride(useTenant)

    const [slow, fast] = await Promise.all([
      withTenant("slow", async () => {
        await delay(ASYNC_CONTEXT_DELAY_MS)
        return useTenant()
      }),
      withTenant("fast", () => useTenant()),
    ])

    expect([slow, fast]).toEqual(["slow", "fast"])
    await runtime.dispose()
  })

  it("hands the value over to each call with dispose: true", async () => {
    const runtime = createRuntime()
    const closed: string[] = []
    const useConnection = runtime.defineDependency<{ id: string }>({
      name: "connection",
      dispose: (connection) => void closed.push(connection.id),
    })
    const withConnection = runtime.createValueOverride(useConnection, {
      dispose: true,
    })

    await withConnection({ id: "first" }, () => useConnection().id)
    expect(closed).toEqual(["first"])

    // Every call builds its own provision, so a second call is never a reuse.
    const failure = new Error("callback")
    await expect(
      withConnection({ id: "second" }, () => {
        throw failure
      }),
    ).rejects.toBe(failure)

    expect(closed).toEqual(["first", "second"])
    await runtime.dispose()
  })

  it("uses a disposer configured on the helper", async () => {
    const runtime = createRuntime()
    const released: string[] = []
    const useLease = runtime.defineDependency<{ id: string }>({ name: "lease" })
    const withLease = runtime.createValueOverride(useLease, {
      dispose: (lease) => void released.push(lease.id),
    })

    await withLease({ id: "lease-1" }, () => useLease().id)

    expect(released).toEqual(["lease-1"])
    await runtime.dispose()
  })

  it("rejects a dependency from another runtime", async () => {
    const owner = createRuntime({ name: "owner" })
    const other = createRuntime({ name: "other" })
    const useClient = owner.defineDependency<object>({ name: "client" })

    expect(() => other.createValueOverride(useClient)).toThrow(
      CrossRuntimeDependencyError,
    )
    expect(() => createValueOverride(useClient)).toThrow(
      CrossRuntimeDependencyError,
    )

    await owner.dispose()
    await other.dispose()
  })
})
