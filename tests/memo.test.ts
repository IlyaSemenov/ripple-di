import { describe, expect, it } from "bun:test"

import {
  AsyncMemoError,
  CrossRuntimeDependencyError,
  CrossScopeResolutionError,
  createRuntime,
  DisposerContextError,
  MemoCycleError,
  MemoScopeOperationError,
  memo,
  memoize,
  provide,
} from "ripple-di"

describe("dependency-aware memoization", () => {
  it("reuses by dependency identity and ignores unrelated overrides", async () => {
    const runtime = createRuntime()
    const Config = runtime.defineDependency(() => "root")
    const Unrelated = runtime.defineDependency(() => "unrelated")
    let calls = 0

    class Example {
      @memo
      get value() {
        calls += 1
        return Config()
      }
    }

    const example = new Example()
    expect(example.value).toBe("root")
    expect(example.value).toBe("root")
    expect(calls).toBe(1)

    const unrelated = runtime.createScope(provide(Unrelated, "changed"))
    expect(unrelated.run(() => example.value)).toBe("root")
    expect(calls).toBe(1)
    await unrelated.close()

    const overridden = runtime.createScope(provide(Config, "override"))
    expect(overridden.run(() => example.value)).toBe("override")
    expect(overridden.run(() => example.value)).toBe("override")
    expect(calls).toBe(2)
    await overridden.close()

    expect(example.value).toBe("root")
    expect(calls).toBe(3)
    await runtime.dispose()
  })

  it("tracks factory dependencies and reads made by their invocation", async () => {
    const runtime = createRuntime()
    const Config = runtime.defineDependency(() => "root")
    const MakeThing = runtime.defineFactoryDependency(
      (id: number) => `${id}:${Config()}`,
    )
    let calls = 0

    class Example {
      readonly id = 7

      @memo
      get thing() {
        calls += 1
        return MakeThing(this.id)
      }
    }

    const example = new Example()
    expect(example.thing).toBe("7:root")

    const configScope = runtime.createScope(provide(Config, "configured"))
    expect(configScope.run(() => example.thing)).toBe("7:configured")
    await configScope.close()

    const factoryScope = runtime.createScope(
      provide(MakeThing, (id) => `${id}:replacement`),
    )
    expect(factoryScope.run(() => example.thing)).toBe("7:replacement")
    expect(calls).toBe(3)
    await factoryScope.close()
    await runtime.dispose()
  })

  it("propagates dependencies through nested memos and dependency factories", async () => {
    const runtime = createRuntime()
    const A = runtime.defineDependency(() => "root")
    let innerCalls = 0
    let outerCalls = 0

    class Example {
      @memo
      get inner() {
        innerCalls += 1
        return A()
      }

      @memo
      get outer() {
        outerCalls += 1
        return `[${this.inner}]`
      }
    }

    const example = new Example()
    const Derived = runtime.defineDependency(() => ({ value: example.outer }))
    const root = Derived()
    expect(Derived()).toBe(root)

    const scope = runtime.createScope(provide(A, "override"))
    expect(scope.run(() => example.outer)).toBe("[override]")
    expect(scope.run(() => Derived().value)).toBe("[override]")
    expect(innerCalls).toBe(2)
    expect(outerCalls).toBe(2)
    await scope.close()
    await runtime.dispose()
  })

  it("keeps object instances and zero-argument methods isolated", async () => {
    const runtime = createRuntime()
    const Value = runtime.defineDependency(() => ({ label: "value" }))
    let calls = 0

    class Example {
      @memo
      read() {
        calls += 1
        return { dependency: Value() }
      }
    }

    const left = new Example()
    const right = new Example()
    expect(left.read()).toBe(left.read())
    expect(right.read()).toBe(right.read())
    expect(left.read()).not.toBe(right.read())
    expect(calls).toBe(2)
    await runtime.dispose()
  })

  it("does not cache failures or damage nested tracking", async () => {
    const runtime = createRuntime()
    const Value = runtime.defineDependency(() => "value")
    let calls = 0
    const computation = memoize(() => {
      calls += 1
      if (calls === 1) {
        throw new Error("failed")
      }
      return Value()
    })

    expect(computation).toThrow("failed")
    expect(computation()).toBe("value")
    expect(computation()).toBe("value")
    expect(calls).toBe(2)
    expect(Value()).toBe("value")
    await runtime.dispose()
  })

  it("propagates dependencies when a nested memo throws a user error", async () => {
    const runtime = createRuntime()
    const Value = runtime.defineDependency(() => "root")
    let outerCalls = 0
    const inner = memoize(() => {
      const value = Value()
      throw new Error(value)
    })
    const outer = memoize(() => {
      outerCalls += 1
      try {
        return inner()
      } catch {
        return "fallback"
      }
    })

    expect(outer()).toBe("fallback")
    expect(outer()).toBe("fallback")
    expect(outerCalls).toBe(1)

    const scope = runtime.createScope(provide(Value, "override"))
    expect(scope.run(outer)).toBe("fallback")
    expect(outerCalls).toBe(2)
    await scope.close()
    await runtime.dispose()
  })

  it("does not cache a nested missing-provider error that was caught", async () => {
    const runtime = createRuntime()
    const Missing = runtime.defineDependency<string>()
    let outerCalls = 0
    const inner = memoize(() => Missing())
    const outer = memoize(() => {
      outerCalls += 1
      try {
        return inner()
      } catch {
        return "fallback"
      }
    })

    expect(outer()).toBe("fallback")
    expect(outer()).toBe("fallback")
    expect(outerCalls).toBe(2)

    const scope = runtime.createScope(provide(Missing, "provided"))
    expect(scope.run(outer)).toBe("provided")
    expect(outerCalls).toBe(3)
    await scope.close()
    await runtime.dispose()
  })

  it("does not cache a nested cross-runtime error that was caught", async () => {
    const owningRuntime = createRuntime({ name: "owning" })
    const foreignRuntime = createRuntime({ name: "foreign" })
    const OwningValue = owningRuntime.defineDependency(() => "owning")
    const ForeignValue = foreignRuntime.defineDependency(() => "foreign")
    let outerCalls = 0
    const inner = memoize(() => ForeignValue())
    const outer = memoize(() => {
      outerCalls += 1
      OwningValue()
      try {
        return inner()
      } catch (error) {
        expect(error).toBeInstanceOf(CrossRuntimeDependencyError)
        return "fallback"
      }
    })

    expect(outer()).toBe("fallback")
    expect(outer()).toBe("fallback")
    expect(outerCalls).toBe(2)
    await owningRuntime.dispose()
    await foreignRuntime.dispose()
  })

  it("rejects native promises and argument-keyed calls", () => {
    const asynchronous = memoize(function loadAsynchronously() {
      return Promise.resolve("value")
    })
    const computation = memoize(() => "value")

    expect(asynchronous).toThrow(AsyncMemoError)
    try {
      asynchronous()
    } catch (error) {
      expect((error as AsyncMemoError).computationName).toBe(
        "loadAsynchronously",
      )
    }
    expect(() => Reflect.apply(computation, undefined, ["argument"])).toThrow(
      TypeError,
    )
    expect(() => Reflect.apply(computation, null, [])).toThrow(TypeError)
  })

  it("rejects scope management from a memo computation", async () => {
    const runtime = createRuntime()

    class Example {
      @memo
      get value() {
        runtime.createScope()
        return "value"
      }
    }

    let error: unknown
    try {
      new Example().value
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(MemoScopeOperationError)
    expect((error as MemoScopeOperationError).computationName).toBe("value")
    expect((error as MemoScopeOperationError).operation).toBe(
      "Runtime.createScope",
    )
    await runtime.dispose()
  })

  it("guards the bound runtime but permits an independent runtime", async () => {
    const boundRuntime = createRuntime({ name: "bound" })
    const independentRuntime = createRuntime({ name: "independent" })
    const Value = boundRuntime.defineDependency(() => "value")
    let boundError: unknown
    const computation = memoize(() => {
      const value = Value()
      try {
        boundRuntime.createScope()
      } catch (error) {
        boundError = error
      }
      return {
        scope: independentRuntime.createScope(),
        value,
      }
    })

    const result = computation()
    expect(result.value).toBe("value")
    expect(boundError).toBeInstanceOf(MemoScopeOperationError)
    expect((boundError as MemoScopeOperationError).operation).toBe(
      "Runtime.createScope",
    )
    await result.scope.close()
    await boundRuntime.dispose()
    await independentRuntime.dispose()
  })

  it("reports memo cycles and restores the tracking stack", async () => {
    const runtime = createRuntime()
    const Value = runtime.defineDependency(() => "value")

    class Example {
      @memo
      get left(): string {
        return this.right
      }

      @memo
      get right(): string {
        return this.left
      }
    }

    let error: unknown
    try {
      new Example().left
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(MemoCycleError)
    expect((error as MemoCycleError).path).toEqual(["left", "right", "left"])
    expect(Value()).toBe("value")
    await runtime.dispose()
  })

  it("rejects explicit resolution from another factory scope", async () => {
    const runtime = createRuntime()
    const Value = runtime.defineDependency(() => "value")
    const requestedScope = runtime.createScope()
    const factoryScope = runtime.createScope()
    const computation = memoize(() => requestedScope.resolve(Value))
    const Derived = runtime.defineDependency(() => computation())

    expect(() => factoryScope.resolve(Derived)).toThrow(
      CrossScopeResolutionError,
    )
    await requestedScope.close()
    await factoryScope.close()
    await runtime.dispose()
  })

  it("does not serve a cached dependency value from disposer context", async () => {
    const runtime = createRuntime()
    const Value = runtime.defineDependency(() => "value")
    const computation = memoize(() => Value())
    let disposerError: unknown
    const Resource = runtime.defineDependency(
      () => ({ value: computation() }),
      {
        dispose: () => {
          try {
            computation()
          } catch (error) {
            disposerError = error
          }
        },
      },
    )

    expect(Resource().value).toBe("value")
    await runtime.dispose()
    expect(disposerError).toBeInstanceOf(DisposerContextError)
  })
})
