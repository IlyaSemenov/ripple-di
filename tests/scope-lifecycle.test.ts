import { describe, expect, it } from "bun:test"

import type { Scope } from "ripple-di"
import {
  createRuntime,
  DetachedContextOwnedProvisionError,
  DisposerContextError,
  DuplicateProviderError,
  FactoryError,
  LeakedChildScopeError,
  MissingProviderError,
  OwnedProvisionReuseError,
  provide,
  provideFactory,
  ScopeClosedError,
} from "ripple-di"

import { createQueryBuilder } from "./awaitable"

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

// A short timer forces a real async context switch without slowing the suite.
const ASYNC_CONTEXT_DELAY_MS = 5
// Distinctive value used to prove a successful callback result is preserved.
const CALLBACK_RESULT = 42

describe("scope creation", () => {
  it("validates duplicate lists before installing owned values", async () => {
    const runtime = createRuntime()
    const useValue = runtime.defineDependency<object>({ name: "value" })
    const value = {}
    let disposed = 0
    const owned = provide(useValue, value, {
      dispose: () => {
        disposed += 1
      },
    })

    expect(() => runtime.createScope([owned, owned])).toThrow(
      DuplicateProviderError,
    )
    expect(disposed).toBe(0)
    const scope = runtime.createScope([owned])
    await scope.close()
    expect(disposed).toBe(1)
    await runtime.dispose()
    expect(disposed).toBe(1)
  })

  it("rejects installing one owned-value provision in two scopes", async () => {
    const runtime = createRuntime()
    const useValue = runtime.defineDependency<object>({ name: "value" })
    const value = {}
    let disposed = 0
    const owned = provide(useValue, value, {
      dispose: () => {
        disposed += 1
      },
    })
    const owner = runtime.createScope([owned])

    expect(() => runtime.createScope([owned])).toThrow(OwnedProvisionReuseError)
    await owner.close()
    expect(disposed).toBe(1)
    await runtime.dispose()
  })

  it("keeps borrowed-value and factory provisions reusable", async () => {
    const runtime = createRuntime()
    const useBorrowed = runtime.defineDependency<object>({ name: "borrowed" })
    const useCreated = runtime.defineDependency<object>({ name: "created" })
    const borrowedValue = {}
    const borrowed = provide(useBorrowed, borrowedValue)
    const created = provideFactory(useCreated, () => ({}))
    const left = runtime.createScope([borrowed, created])
    const right = runtime.createScope([borrowed, created])

    expect(left.resolve(useBorrowed)).toBe(borrowedValue)
    expect(right.resolve(useBorrowed)).toBe(borrowedValue)
    expect(left.resolve(useCreated)).not.toBe(right.resolve(useCreated))
    await left.close()
    await right.close()
    await runtime.dispose()
  })
})

describe("ambient scope and concurrency", () => {
  it("routes runtime methods through the active scope", async () => {
    const runtime = createRuntime()
    const useValue = runtime.defineDependency(() => "root", {
      name: "value",
    })
    const parent = runtime.createScope([provide(useValue, "parent")])
    let child: Scope | undefined

    await parent.run(async () => {
      expect(runtime.resolve(useValue)).toBe("parent")
      expect(
        await runtime.withOverrides([provide(useValue, "nested")], () =>
          useValue(),
        ),
      ).toBe("nested")

      child = runtime.createScope()
      expect(child.resolve(useValue)).toBe("parent")
    })

    await child?.close()
    await parent.close()
    await runtime.dispose()
  })

  it("runs detached overrides outside the current ambient scope", async () => {
    const runtime = createRuntime()
    const useTenant = runtime.defineDependency<string>({ name: "tenant" })
    const useTail = runtime.defineDependency<string>({ name: "tail" })
    const installation = runtime.install(provide(useTenant, "installed"))
    let releaseTail!: () => void
    const tailGate = new Promise<void>((resolve) => {
      releaseTail = resolve
    })
    let detachedTail!: Promise<string>

    await runtime.withOverrides(provide(useTenant, "request"), () => {
      expect(useTenant()).toBe("request")
      detachedTail = runtime.withDetachedOverrides(
        provide(useTail, "detached"),
        async (scope) => {
          expect(useTenant()).toBe("installed")
          expect(scope.resolve(useTail)).toBe("detached")
          await tailGate
          return `${useTenant()}/${useTail()}`
        },
      )
    })

    releaseTail()
    expect(await detachedTail).toBe("installed/detached")
    await installation.close()
    await runtime.dispose()
  })

  it("isolates parallel overrides and keeps siblings independent", async () => {
    const runtime = createRuntime()
    const useValue = runtime.defineDependency(() => "root", {
      name: "value",
    })
    const useView = runtime.defineDependency(() => ({ value: useValue() }), {
      name: "view",
    })

    const results = await Promise.all([
      runtime.withOverrides([provide(useValue, "left")], async (scope) => {
        const identity = useView()
        await delay(ASYNC_CONTEXT_DELAY_MS)
        expect(useView()).toBe(identity)
        expect(scope.resolve(useView)).toBe(identity)
        return identity.value
      }),
      runtime.withOverrides([provide(useValue, "right")], async () => {
        await Promise.resolve()
        return useView().value
      }),
    ])
    expect(results).toEqual(["left", "right"])

    const left = runtime.createScope([provide(useValue, "left")])
    const right = runtime.createScope([provide(useValue, "right")])
    await left.close()
    expect(right.resolve(useView).value).toBe("right")
    await right.close()
    await runtime.dispose()
  })

  it("runs one live scope repeatedly and rejects detached reads after close", async () => {
    const runtime = createRuntime()
    const useValue = runtime.defineDependency(() => "root", {
      name: "value",
    })
    const scope = runtime.createScope([provide(useValue, "scope")])

    expect(scope.run(() => useValue())).toBe("scope")
    expect(scope.run(() => useValue())).toBe("scope")

    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let detached!: Promise<string>
    scope.run(() => {
      detached = gate.then(() => useValue())
    })
    await scope.close()
    release()
    await expect(detached).rejects.toBeInstanceOf(ScopeClosedError)
    await runtime.dispose()
  })
})

describe("detached context", () => {
  it("rejects capture from the current retiring scope", async () => {
    const runtime = createRuntime()
    const useValue = runtime.defineDependency<string>({ name: "value" })
    const parent = runtime.createScope([provide(useValue, "parent")])
    const child = parent.createScope()
    let continueCallback!: () => void
    const callbackGate = new Promise<void>((resolve) => {
      continueCallback = resolve
    })
    let error: unknown

    const callback = parent.run(async () => {
      await callbackGate
      error = await runtime
        .withDetachedContext(() => useValue())
        .then(
          () => undefined,
          (reason) => reason,
        )
    })
    const retirement = parent.retire()
    continueCallback()
    await callback

    expect(error).toBeInstanceOf(ScopeClosedError)
    expect((error as ScopeClosedError).state).toBe("retiring")
    await child.close()
    await retirement
    await runtime.dispose()
  })

  it("captures through a retiring ancestor from its active child", async () => {
    const runtime = createRuntime()
    const useParent = runtime.defineDependency<string>({ name: "parent" })
    const useChild = runtime.defineDependency<string>({ name: "child" })
    const parent = runtime.createScope([provide(useParent, "parent")])
    const child = parent.createScope([provide(useChild, "child")])
    const retirement = parent.retire()

    const value = await child.run(() =>
      runtime.withDetachedContext(() => `${useParent()}/${useChild()}`),
    )

    expect(value).toBe("parent/child")
    await child.close()
    await retirement
    await runtime.dispose()
  })

  it("replays nested borrowed overrides after their source scopes close", async () => {
    const runtime = createRuntime()
    const useLocale = runtime.defineDependency<string>({ name: "locale" })
    const useTraceId = runtime.defineDependency<string>({ name: "trace-id" })
    const sharedContext = { requestId: "request-42" }
    const useContext = runtime.defineDependency<object>({ name: "context" })
    const installation = runtime.install([
      provide(useLocale, "en"),
      provide(useTraceId, "application"),
    ])
    let releaseBackgroundWork!: () => void
    const backgroundGate = new Promise<void>((resolve) => {
      releaseBackgroundWork = resolve
    })
    let backgroundTask!: Promise<readonly [string, string, object]>

    await runtime.withOverrides(
      [provide(useLocale, "de"), provide(useContext, sharedContext)],
      () =>
        runtime.withOverrides(provide(useTraceId, "request-42"), () => {
          backgroundTask = runtime.withDetachedContext(async (scope) => {
            await backgroundGate
            return [
              useLocale(),
              useTraceId(),
              scope.resolve(useContext),
            ] as const
          })
        }),
    )

    expect(runtime.resolve(useLocale)).toBe("en")
    expect(runtime.resolve(useTraceId)).toBe("application")
    releaseBackgroundWork()
    expect(await backgroundTask).toEqual(["de", "request-42", sharedContext])
    await installation.close()
    await runtime.dispose()
  })

  it("recreates factory values and caches in their original layer boundaries", async () => {
    const runtime = createRuntime()
    const disposed: string[] = []
    let nextOuterId = 1
    let nextInnerId = 1
    const useOuter = runtime.defineDependency<{ id: string }>({
      name: "outer",
      dispose: (value) => {
        disposed.push(value.id)
      },
    })
    const useInner = runtime.defineDependency<{ id: string }>({
      name: "inner",
      dispose: (value) => {
        disposed.push(value.id)
      },
    })
    const useDerived = runtime.defineDependency(() => ({
      outer: useOuter(),
      inner: useInner(),
    }))
    let releaseBackgroundWork!: () => void
    const backgroundGate = new Promise<void>((resolve) => {
      releaseBackgroundWork = resolve
    })
    let sourceDerived!: ReturnType<typeof useDerived>
    let backgroundTask!: Promise<ReturnType<typeof useDerived>>

    await runtime.withOverrides(
      provideFactory(useOuter, () => ({ id: `outer-${nextOuterId++}` })),
      () =>
        runtime.withOverrides(
          provideFactory(useInner, () => ({ id: `inner-${nextInnerId++}` })),
          () => {
            useInner()
            useOuter()
            sourceDerived = useDerived()
            backgroundTask = runtime.withDetachedContext(async () => {
              useInner()
              useOuter()
              const derived = useDerived()
              await backgroundGate
              return derived
            })
          },
        ),
    )

    expect(disposed).toEqual(["inner-1", "outer-1"])
    releaseBackgroundWork()
    const detachedDerived = await backgroundTask
    expect(detachedDerived).not.toBe(sourceDerived)
    expect(detachedDerived.outer.id).toBe("outer-2")
    expect(detachedDerived.inner.id).toBe("inner-2")
    expect(disposed).toEqual(["inner-1", "outer-1", "inner-2", "outer-2"])
    await runtime.dispose()
  })

  it("rejects owned values before creating a detached scope", async () => {
    const runtime = createRuntime()
    const useConnection = runtime.defineDependency<object>({
      name: "connection",
    })
    const connection = {}
    let disposed = 0
    let callbackCalled = false

    await runtime.withOverrides(
      provide(useConnection, connection, {
        dispose: () => {
          disposed += 1
        },
      }),
      async () => {
        const error = await runtime
          .withDetachedContext(() => {
            callbackCalled = true
          })
          .then(
            () => undefined,
            (reason) => reason,
          )

        expect(error).toBeInstanceOf(DetachedContextOwnedProvisionError)
        expect(
          (error as DetachedContextOwnedProvisionError).dependencyName,
        ).toBe("connection")
      },
    )

    expect(callbackCalled).toBe(false)
    expect(disposed).toBe(1)
    const installation = runtime.install([])
    await installation.close()
    await runtime.dispose()
  })

  it("keeps parallel detached contexts isolated", async () => {
    const runtime = createRuntime()
    let nextSessionId = 1
    const useSession = runtime.defineDependency<{ id: number }>({
      name: "session",
    })
    let backgroundTasks!: readonly [Promise<number>, Promise<number>]

    await runtime.withOverrides(
      provideFactory(useSession, () => ({ id: nextSessionId++ })),
      () => {
        backgroundTasks = [
          runtime.withDetachedContext(async () => {
            const session = useSession()
            await delay(ASYNC_CONTEXT_DELAY_MS)
            expect(useSession()).toBe(session)
            return session.id
          }),
          runtime.withDetachedContext(() => useSession().id),
        ]
      },
    )

    expect(await Promise.all(backgroundTasks)).toEqual([1, 2])
    await runtime.dispose()
  })
})

describe("owned value lifecycle", () => {
  it("does not dispose borrowed values or borrowed parent values", async () => {
    const runtime = createRuntime()
    let createdDisposals = 0
    const useOwnedValue = runtime.defineDependency(() => ({}), {
      name: "owned-value",
      dispose: () => {
        createdDisposals += 1
      },
    })
    const borrowed = {}
    const parent = runtime.createScope([provide(useOwnedValue, borrowed)])
    const child = parent.createScope()

    expect(child.resolve(useOwnedValue)).toBe(borrowed)
    await child.close()
    await parent.close()
    await runtime.dispose()
    expect(createdDisposals).toBe(0)
  })

  it("disposes a child-owned value exactly once", async () => {
    const runtime = createRuntime()
    const useScopeOwner = runtime.defineDependency<object>()
    let disposed = 0
    const useOwnedValue = runtime.defineDependency(
      () => ({ owner: useScopeOwner() }),
      {
        name: "owned-value",
        dispose: () => {
          disposed += 1
        },
      },
    )
    const child = runtime.createScope([provide(useScopeOwner, {})])
    child.resolve(useOwnedValue)

    const close1 = child.close()
    const close2 = child.close()
    expect(close1).toBe(close2)
    await close1
    expect(disposed).toBe(1)
    await runtime.dispose()
  })

  it("prefers asynchronous standard cleanup for factory-owned values", async () => {
    const runtime = createRuntime()
    const disposals: string[] = []
    const useResource = runtime.defineDependency(
      () => ({
        async [Symbol.asyncDispose]() {
          await delay(ASYNC_CONTEXT_DELAY_MS)
          disposals.push("async")
        },
        [Symbol.dispose]() {
          disposals.push("sync")
        },
      }),
      { name: "resource", dispose: true },
    )

    runtime.resolve(useResource)
    await runtime.dispose()
    expect(disposals).toEqual(["async"])
  })

  it("falls back to synchronous standard cleanup for provideFactory", async () => {
    const runtime = createRuntime()
    const disposals: string[] = []
    const useResource = runtime.defineDependency<Disposable>({
      name: "resource",
      dispose: true,
    })
    const scope = runtime.createScope(
      provideFactory(useResource, () => ({
        [Symbol.dispose]() {
          disposals.push("sync")
        },
      })),
    )

    scope.resolve(useResource)
    await scope.close()
    expect(disposals).toEqual(["sync"])
    await runtime.dispose()
  })

  it("captures standard cleanup for handed-over values and borrows plain values", async () => {
    const runtime = createRuntime()
    const disposals: string[] = []
    const useResource = runtime.defineDependency<AsyncDisposable>({
      name: "resource",
      dispose: true,
    })
    const owned = {
      async [Symbol.asyncDispose]() {
        disposals.push("captured")
      },
    }
    const borrowed = {
      async [Symbol.asyncDispose]() {
        disposals.push("borrowed")
      },
    }
    const ownedScope = runtime.createScope(
      provide(useResource, owned, { dispose: true }),
    )
    const borrowedScope = runtime.createScope(provide(useResource, borrowed))

    owned[Symbol.asyncDispose] = async () => {
      disposals.push("replacement")
    }
    await ownedScope.close()
    await borrowedScope.close()
    expect(disposals).toEqual(["captured"])
    await runtime.dispose()
  })

  it("rejects standard cleanup when an owned value has no disposal method", async () => {
    const runtime = createRuntime()
    const useResource = runtime.defineDependency(() => ({}), {
      name: "resource",
      dispose: true,
    })

    expect(() => runtime.resolve(useResource)).toThrow(
      'Dependency "resource" configured dispose: true, but its owned value ' +
        "implements neither Symbol.asyncDispose nor Symbol.dispose.",
    )
    await runtime.dispose()
  })

  it("disposes unread owned values but not unread borrowed values", async () => {
    const runtime = createRuntime()
    const useOwned = runtime.defineDependency<object>({ name: "owned" })
    const useBorrowed = runtime.defineDependency<object>({ name: "borrowed" })
    let ownedDisposals = 0
    const borrowedDisposals = 0
    const scope = runtime.createScope([
      provide(
        useOwned,
        {},
        {
          dispose: () => {
            ownedDisposals += 1
          },
        },
      ),
      provide(useBorrowed, {}),
    ])

    await scope.close()
    expect(ownedDisposals).toBe(1)
    expect(borrowedDisposals).toBe(0)
    await runtime.dispose()
  })

  it("can transfer an existing value with the configured disposer", async () => {
    const runtime = createRuntime()
    const disposed: object[] = []
    const useOwnedValue = runtime.defineDependency(() => ({}), {
      name: "owned-value",
      dispose: (value) => {
        disposed.push(value)
      },
    })
    const value = {}
    const scope = runtime.createScope([
      provide(useOwnedValue, value, { dispose: true }),
    ])

    await scope.close()
    expect(disposed).toEqual([value])
    await runtime.dispose()
  })

  it("uses the configured disposer for a provideFactory value", async () => {
    const runtime = createRuntime()
    const disposed: object[] = []
    const useOwnedValue = runtime.defineDependency(() => ({}), {
      name: "owned-value",
      dispose: (value) => {
        disposed.push(value)
      },
    })
    const value = {}
    const scope = runtime.createScope([
      provideFactory(useOwnedValue, () => value),
    ])

    expect(scope.resolve(useOwnedValue)).toBe(value)
    expect(disposed).toEqual([])
    await scope.close()
    expect(disposed).toEqual([value])
    await scope.close()
    expect(disposed).toEqual([value])
    await runtime.dispose()
  })

  it("applies cleanup configured without a built-in factory only to owned values", async () => {
    const runtime = createRuntime()
    const disposed: object[] = []
    const useExternal = runtime.defineDependency<object>({
      name: "external",
      dispose: (value) => {
        disposed.push(value)
      },
    })
    const borrowed = {}
    const borrowedScope = runtime.createScope([provide(useExternal, borrowed)])

    expect(borrowedScope.resolve(useExternal)).toBe(borrowed)
    await borrowedScope.close()
    expect(disposed).toEqual([])

    const owned = {}
    const ownedScope = runtime.createScope([
      provide(useExternal, owned, { dispose: true }),
    ])
    await ownedScope.close()
    expect(disposed).toEqual([owned])

    const created = {}
    const installation = runtime.install([
      provideFactory(useExternal, () => created),
    ])
    expect(runtime.resolve(useExternal)).toBe(created)
    await installation.close()
    expect(disposed).toEqual([owned, created])
    expect(() => runtime.resolve(useExternal)).toThrow(MissingProviderError)

    await runtime.dispose()
  })

  it("does not clean up a failed external factory", async () => {
    const runtime = createRuntime()
    const failure = new Error("factory failed")
    let factoryCalls = 0
    let disposeCalls = 0
    const useExternal = runtime.defineDependency<object>({
      name: "external",
      dispose: () => {
        disposeCalls += 1
      },
    })
    const scope = runtime.createScope([
      provideFactory(useExternal, () => {
        factoryCalls += 1
        throw failure
      }),
    ])

    expect(() => scope.resolve(useExternal)).toThrow(FactoryError)
    expect(() => scope.resolve(useExternal)).toThrow(FactoryError)
    expect(factoryCalls).toBe(2)
    await scope.close()
    expect(disposeCalls).toBe(0)
    await runtime.dispose()
  })

  it("disposes consumers before dependencies and awaits async disposers", async () => {
    const runtime = createRuntime()
    const order: string[] = []
    const useDependency = runtime.defineDependency(() => ({}), {
      name: "dependency",
      dispose: async () => {
        await delay(ASYNC_CONTEXT_DELAY_MS)
        order.push("dependency")
      },
    })
    const useConsumer = runtime.defineDependency(
      () => ({ dependency: useDependency() }),
      {
        name: "consumer",
        dispose: () => {
          order.push("consumer")
        },
      },
    )
    runtime.resolve(useConsumer)

    await runtime.dispose()
    expect(order).toEqual(["consumer", "dependency"])
  })

  it("aggregates disposer failures after running every finalizer", async () => {
    const runtime = createRuntime()
    const order: string[] = []
    const useDependency = runtime.defineDependency(() => ({}), {
      name: "dependency",
      dispose: () => {
        order.push("dependency")
        throw new Error("dependency failed")
      },
    })
    const useConsumer = runtime.defineDependency(
      () => ({ dependency: useDependency() }),
      {
        name: "consumer",
        dispose: () => {
          order.push("consumer")
          throw new Error("consumer failed")
        },
      },
    )
    runtime.resolve(useConsumer)

    const error = await runtime.dispose().then(
      () => undefined,
      (reason) => reason as AggregateError,
    )
    expect(error).toBeInstanceOf(AggregateError)
    expect(error?.errors).toHaveLength(2)
    expect(order).toEqual(["consumer", "dependency"])
    expect(() => runtime.resolve(useDependency)).toThrow(ScopeClosedError)
  })

  it("rejects dependency reads and scope management during teardown", async () => {
    const runtime = createRuntime()
    const closedInstallation = runtime.install([])
    await closedInstallation.close()
    const installation = runtime.install([])
    const useOwner = runtime.defineDependency<object>({ name: "owner" })
    const useContext = runtime.defineDependency(() => "root", {
      name: "context",
    })
    const child = runtime.createScope([
      provide(useOwner, {}),
      provide(useContext, "child"),
    ])
    const operations: readonly [string, () => void | Promise<void>][] = [
      [
        "Dependency read",
        () => {
          useContext()
        },
      ],
      ["Runtime.install", () => runtime.install([])],
      [
        "Runtime.createScope",
        () => {
          runtime.createScope()
        },
      ],
      ["Runtime.withOverrides", () => runtime.withOverrides([], () => {})],
      [
        "Runtime.withDetachedOverrides",
        () => runtime.withDetachedOverrides([], () => {}),
      ],
      [
        "Runtime.withDetachedContext",
        () => runtime.withDetachedContext(() => {}),
      ],
      [
        "OverrideRunner.run",
        () => runtime.createOverrideRunner(() => []).run(() => {}),
      ],
      [
        "ValueOverride",
        () => runtime.createValueOverride(useContext)("value", () => {}),
      ],
      ["Runtime.dispose", () => runtime.dispose()],
      ["Installation.close", () => installation.close()],
      ["Installation.close (closed)", () => closedInstallation.close()],
      [
        "Scope.createScope",
        () => {
          child.createScope()
        },
      ],
      ["Scope.run", () => child.run(() => {})],
      ["Scope.withOverrides", () => child.withOverrides([], () => {})],
      ["Scope.retire", () => child.retire()],
      ["Scope.close", () => child.close()],
    ]
    const ownedValues = operations.map(([name, operation]) =>
      runtime.defineDependency(() => ({ owner: useOwner() }), {
        name,
        dispose: operation,
      }),
    )
    for (const useOwnedValue of ownedValues) {
      child.resolve(useOwnedValue)
    }

    const error = await child.close().then(
      () => undefined,
      (reason) => reason as AggregateError,
    )
    expect(error).toBeInstanceOf(AggregateError)
    expect(error?.errors).toHaveLength(operations.length)
    for (const failure of error?.errors ?? []) {
      expect(failure).toBeInstanceOf(DisposerContextError)
    }
    await installation.close()
    await runtime.dispose()
  })

  it("allows installation lifecycle in an independent runtime during teardown", async () => {
    const closingRuntime = createRuntime()
    const independentRuntime = createRuntime()
    const useOwnedValue = closingRuntime.defineDependency(() => ({}), {
      dispose: () => independentRuntime.install([]).close(),
    })
    closingRuntime.resolve(useOwnedValue)

    await closingRuntime.dispose()
    const replacement = independentRuntime.install([])
    await replacement.close()
    await independentRuntime.dispose()
  })

  it("retains the teardown restriction in async work started by a disposer", async () => {
    const runtime = createRuntime()
    const useOwner = runtime.defineDependency<object>({ name: "owner" })
    const useContext = runtime.defineDependency(() => "root", {
      name: "context",
    })
    let detachedRead: Promise<string> | undefined
    const useOwnedValue = runtime.defineDependency(
      () => ({ owner: useOwner() }),
      {
        name: "owned-value",
        dispose: () => {
          detachedRead = delay(ASYNC_CONTEXT_DELAY_MS).then(() => useContext())
        },
      },
    )
    const child = runtime.createScope([provide(useOwner, {})])
    child.resolve(useOwnedValue)

    await child.close()
    await expect(detachedRead).rejects.toBeInstanceOf(DisposerContextError)
    await runtime.dispose()
  })

  it("releases child membership even when its disposer fails", async () => {
    const runtime = createRuntime()
    const useScopeOwner = runtime.defineDependency<object>()
    const useBad = runtime.defineDependency(
      () => ({ owner: useScopeOwner() }),
      {
        name: "bad",
        dispose: () => {
          throw new Error("bad dispose")
        },
      },
    )
    const parent = runtime.createScope()
    const child = parent.createScope([provide(useScopeOwner, {})])
    child.resolve(useBad)

    await child.close().catch(() => {})
    await parent.retire()
    await runtime.dispose()
  })
})

describe("retire and close", () => {
  it("delegates asynchronous disposal to close", async () => {
    const runtime = createRuntime()
    const scope = runtime.createScope()

    await scope[Symbol.asyncDispose]()
    expect(() => scope.run(() => {})).toThrow(ScopeClosedError)
    await runtime.dispose()
  })

  it("retire waits for live children while they can inherit from the parent", async () => {
    const runtime = createRuntime()
    const useValue = runtime.defineDependency<string>({ name: "value" })
    const parent = runtime.createScope([provide(useValue, "parent")])
    const child = parent.createScope()
    const retirement = parent.retire()
    let settled = false
    void retirement.then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)
    expect(() => parent.resolve(useValue)).toThrow(ScopeClosedError)
    expect(child.resolve(useValue)).toBe("parent")
    expect(() => parent.createScope()).toThrow(ScopeClosedError)

    await child.close()
    await retirement
    expect(settled).toBe(true)
    await runtime.dispose()
  })

  it("force-close tears down the entire subtree and continues after child errors", async () => {
    const runtime = createRuntime()
    const useScopeOwner = runtime.defineDependency<object>()
    const closed: string[] = []
    const useBad = runtime.defineDependency(
      () => ({ owner: useScopeOwner() }),
      {
        name: "bad",
        dispose: () => {
          closed.push("bad")
          throw new Error("bad")
        },
      },
    )
    const useGood = runtime.defineDependency(
      () => ({ owner: useScopeOwner() }),
      {
        name: "good",
        dispose: () => {
          closed.push("good")
        },
      },
    )
    const parent = runtime.createScope()
    const badChild = parent.createScope([provide(useScopeOwner, {})])
    const goodChild = parent.createScope()
    const grandchild = goodChild.createScope([provide(useScopeOwner, {})])
    badChild.resolve(useBad)
    grandchild.resolve(useGood)

    await expect(parent.close()).rejects.toBeInstanceOf(AggregateError)
    expect(closed).toEqual(["bad", "good"])
    expect(() => badChild.resolve(useBad)).toThrow(ScopeClosedError)
    expect(() => goodChild.createScope()).toThrow(ScopeClosedError)
    await runtime.dispose()
  })

  it("returns one lifecycle promise and escalates retire to force close", async () => {
    const runtime = createRuntime()
    const parent = runtime.createScope()
    const child = parent.createScope()

    const retirement = parent.retire()
    expect(parent.retire()).toBe(retirement)
    expect(parent.close()).toBe(retirement)
    expect(parent.close()).toBe(retirement)
    await retirement
    expect(() => child.createScope()).toThrow(ScopeClosedError)
    await runtime.dispose()
  })
})

describe("withOverrides cleanup", () => {
  it("supports scoped withOverrides relative to an existing scope", async () => {
    const runtime = createRuntime()
    const useValue = runtime.defineDependency(() => "root", {
      name: "value",
    })
    const parent = runtime.createScope([provide(useValue, "parent")])

    const value = await parent.withOverrides([], (scope) => {
      expect(useValue()).toBe("parent")
      return scope.resolve(useValue)
    })
    expect(value).toBe("parent")

    await parent.close()
    await runtime.dispose()
  })

  it("awaits an awaitable callback result before closing the scope", async () => {
    const runtime = createRuntime()
    const useUrl = runtime.defineDependency(() => "root", { name: "url" })
    const events: string[] = []
    const useQueryBuilder = runtime.defineDependency(
      () => createQueryBuilder(useUrl(), () => events.push("query")),
      {
        name: "query-builder",
        dispose: () => {
          events.push("dispose")
        },
      },
    )

    // The callback result is awaited like any other promise, so returning the
    // builder itself runs the query instead of handing the builder back, and
    // the scope closes only after that query settles.
    const rows = await runtime.withOverrides([provide(useUrl, "scoped")], () =>
      useQueryBuilder(),
    )
    expect(rows).toEqual(["rows from scoped"])
    expect(events).toEqual(["query", "dispose"])

    // Wrapping the builder avoids the await, but the caller receives a value
    // whose scope has already closed.
    events.length = 0
    const wrapped = await runtime.withOverrides(
      [provide(useUrl, "scoped")],
      () => ({ builder: useQueryBuilder() }),
    )
    expect(wrapped.builder.url).toBe("scoped")
    expect(events).toEqual(["dispose"])

    // A manually managed scope keeps the value alive and never awaits it.
    events.length = 0
    const scope = runtime.createScope([provide(useUrl, "manual")])
    const direct = scope.run(() => useQueryBuilder())
    expect(direct.url).toBe("manual")
    expect(events).toEqual([])

    await scope.close()
    await runtime.dispose()
  })

  it("always closes its scope after success or callback failure", async () => {
    const runtime = createRuntime()
    const useScopeOwner = runtime.defineDependency<object>()
    const useOwnedValue = runtime.defineDependency(
      () => ({ owner: useScopeOwner() }),
      {
        name: "owned-value",
      },
    )
    let successfulScope: Scope | undefined
    const result = await runtime.withOverrides(
      [provide(useScopeOwner, {})],
      (scope) => {
        successfulScope = scope
        scope.resolve(useOwnedValue)
        return CALLBACK_RESULT
      },
    )
    expect(result).toBe(CALLBACK_RESULT)
    expect(() => successfulScope?.resolve(useOwnedValue)).toThrow(
      ScopeClosedError,
    )

    const callbackError = new Error("callback")
    let failingScope: Scope | undefined
    await expect(
      runtime.withOverrides([], (scope) => {
        failingScope = scope
        throw callbackError
      }),
    ).rejects.toBe(callbackError)
    expect(() => failingScope?.createScope()).toThrow(ScopeClosedError)
    await runtime.dispose()
  })

  it("reports and force-closes leaked children instead of hanging", async () => {
    const runtime = createRuntime()
    const useScopeOwner = runtime.defineDependency<object>()
    let disposed = 0
    const useOwnedValue = runtime.defineDependency(
      () => ({ owner: useScopeOwner() }),
      {
        name: "owned-value",
        dispose: () => {
          disposed += 1
        },
      },
    )
    let leaked: Scope | undefined

    const error = await runtime
      .withOverrides([], (scope) => {
        leaked = scope.createScope([provide(useScopeOwner, {})])
        leaked.resolve(useOwnedValue)
        return "done"
      })
      .then(
        () => undefined,
        (reason) => reason,
      )

    expect(error).toBeInstanceOf(LeakedChildScopeError)
    expect((error as LeakedChildScopeError).leakedChildCount).toBe(1)
    expect(disposed).toBe(1)
    expect(() => leaked?.createScope()).toThrow(ScopeClosedError)
    await runtime.dispose()
  })

  it("preserves callback, leak, and cleanup errors together", async () => {
    const runtime = createRuntime()
    const useScopeOwner = runtime.defineDependency<object>()
    const useBad = runtime.defineDependency(
      () => ({ owner: useScopeOwner() }),
      {
        name: "bad",
        dispose: () => {
          throw new Error("cleanup")
        },
      },
    )
    const callbackError = new Error("callback")

    const error = await runtime
      .withOverrides([], (scope) => {
        const leaked = scope.createScope([provide(useScopeOwner, {})])
        leaked.resolve(useBad)
        throw callbackError
      })
      .then(
        () => undefined,
        (reason) => reason as AggregateError,
      )

    expect(error).toBeInstanceOf(AggregateError)
    expect(error?.errors).toHaveLength(3)
    expect(error?.errors).toContain(callbackError)
    expect(
      error?.errors.some((item) => item instanceof LeakedChildScopeError),
    ).toBe(true)
    expect(
      error?.errors.some(
        (item) => item instanceof Error && item.message === "cleanup",
      ),
    ).toBe(true)
    await runtime.dispose()
  })
})
