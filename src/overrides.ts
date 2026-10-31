import type { DependencyToken } from "./dependency"
import type { RuntimeContext, ScopeContext } from "./graph"
import { provide, type ProvideOptions, type ProvisionInput } from "./provide"
import { type Scope, withChildScope } from "./scope"

/** Builds the provisions for one call of an override runner. */
export type ProvisionFactory = () => ProvisionInput

/**
 * A set of overrides applied to each call in a scope of its own.
 *
 * Create it with `createOverrideRunner`.
 */
export interface OverrideRunner {
  /**
   * Runs a callback with the runner's overrides in a new scope.
   *
   * Concurrent calls stay isolated, and the scope is cleaned up when the
   * callback finishes.
   */
  run<TCallbackResult>(
    callback: (scope: Scope) => TCallbackResult,
  ): Promise<Awaited<TCallbackResult>>
  /**
   * Returns a function that calls the given one through `run`.
   *
   * The returned function passes its arguments and `this` through, and each
   * of its calls is a separate `run`.
   */
  wrap<TThis, TArgs extends unknown[], TCallbackResult>(
    callback: (this: TThis, ...args: TArgs) => TCallbackResult,
  ): (this: TThis, ...args: TArgs) => Promise<Awaited<TCallbackResult>>
  /**
   * Returns a runner with more overrides on top of these ones.
   *
   * Where both provide the same dependency, the added overrides win.
   * This runner stays unchanged.
   */
  extend(factory: ProvisionFactory): OverrideRunner
}

/** Callback shape shared by the nested layers of one run. */
type LayerCallback = (scope: ScopeContext) => unknown

/** Immutable layer that knows the layers it was extended from. */
class OverrideRunnerImpl implements OverrideRunner {
  constructor(
    private readonly runtime: RuntimeContext,
    private readonly base: OverrideRunnerImpl | undefined,
    private readonly factory: ProvisionFactory,
  ) {}

  run<TCallbackResult>(
    callback: (scope: Scope) => TCallbackResult,
  ): Promise<Awaited<TCallbackResult>> {
    this.runtime.assertScopeManagementAllowed("OverrideRunner.run")
    // The innermost layer produces the result of the whole chain.
    return this.enterLayers(this.runtime.currentAmbientScope(), callback) as Promise<
      Awaited<TCallbackResult>
    >
  }

  wrap<TThis, TArgs extends unknown[], TCallbackResult>(
    callback: (this: TThis, ...args: TArgs) => TCallbackResult,
  ): (this: TThis, ...args: TArgs) => Promise<Awaited<TCallbackResult>> {
    // A function expression keeps the caller's receiver available to forward.
    // oxlint-disable-next-line typescript/no-this-alias -- the wrapper's own `this` is the caller's receiver.
    const runner = this
    return function wrapped(this: TThis, ...args: TArgs) {
      return runner.run(() => callback.apply(this, args))
    }
  }

  extend(factory: ProvisionFactory): OverrideRunner {
    return createRunner(this.runtime, this, factory)
  }

  /**
   * Enters the extended layers from the outside in.
   *
   * Staying async keeps a failing provision factory a rejection instead of a
   * synchronous throw, exactly like an invalid provision list.
   */
  private async enterLayers(parent: ScopeContext, callback: LayerCallback): Promise<unknown> {
    // The base layer receives this one's entry as its callback, so the scopes
    // nest in extension order.
    const enter = (scope: ScopeContext) => withChildScope(scope, this.factory(), callback)
    return this.base ? this.base.enterLayers(parent, enter) : enter(parent)
  }
}

function createRunner(
  runtime: RuntimeContext,
  base: OverrideRunnerImpl | undefined,
  factory: ProvisionFactory,
): OverrideRunner {
  if (typeof factory !== "function") {
    throw new TypeError(
      "An override runner needs a function returning provisions, so that " +
        "every call builds its provisions again.",
    )
  }
  return new OverrideRunnerImpl(runtime, base, factory)
}

/** Creates the first layer of a runner for one runtime. */
export function createOverrideRunnerFor(
  runtime: RuntimeContext,
  factory: ProvisionFactory,
): OverrideRunner {
  return createRunner(runtime, undefined, factory)
}

/**
 * Runs a callback with a value provided for one dependency.
 *
 * Create it with `createValueOverride`.
 */
export type ValueOverride<T> = <TCallbackResult>(
  value: T,
  callback: (scope: Scope) => TCallbackResult,
) => Promise<Awaited<TCallbackResult>>

/** Creates a value override bound to one dependency of one runtime. */
export function createValueOverrideFor<T>(
  runtime: RuntimeContext,
  dependency: DependencyToken<T>,
  options: ProvideOptions<NoInfer<T>>,
): ValueOverride<T> {
  return <TCallbackResult>(
    value: T,
    callback: (scope: Scope) => TCallbackResult,
  ): Promise<Awaited<TCallbackResult>> => {
    runtime.assertScopeManagementAllowed("ValueOverride")
    // A provision of its own per call keeps ownership with the call that got
    // the value, exactly like writing the provision at the call site.
    return withChildScope(
      runtime.currentAmbientScope(),
      provide(dependency, value, options),
      callback,
    )
  }
}
