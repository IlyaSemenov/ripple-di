import type { DependencyToken } from "./dependency"
import type { RuntimeContext, ScopeContext } from "./graph"
import { type ProvideOptions, type ProvisionInput, provide } from "./provide"
import { type Scope, withChildScope } from "./scope"

/** Builds the provisions used by one call. */
export type ProvisionFactory = () => ProvisionInput

/**
 * A prepared set of overrides applied separately to each call.
 *
 * Use it when a long-lived object runs every operation in its own short-lived
 * scope with the same providers.
 */
export interface OverrideRunner {
  /**
   * Runs a callback with this runner's overrides.
   *
   * Every call gets its own scope, so concurrent calls stay isolated, and the
   * scope is cleaned up when the callback finishes.
   */
  run<TCallbackResult>(
    callback: (scope: Scope) => TCallbackResult,
  ): Promise<Awaited<TCallbackResult>>
  /**
   * Returns a function that runs the given one with these overrides.
   *
   * Every call of the returned function is one `run` call that forwards the
   * arguments and the receiver it was called with, so nothing exists before
   * the returned function is called.
   */
  wrap<TThis, TArgs extends unknown[], TCallbackResult>(
    callback: (this: TThis, ...args: TArgs) => TCallbackResult,
  ): (this: TThis, ...args: TArgs) => Promise<Awaited<TCallbackResult>>
  /**
   * Returns a runner that adds more overrides on top of these ones.
   *
   * The added overrides replace the ones they share a dependency with, and
   * this runner keeps working on its own.
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
    return this.enterLayers(
      this.runtime.currentAmbientScope(),
      callback,
    ) as Promise<Awaited<TCallbackResult>>
  }

  wrap<TThis, TArgs extends unknown[], TCallbackResult>(
    callback: (this: TThis, ...args: TArgs) => TCallbackResult,
  ): (this: TThis, ...args: TArgs) => Promise<Awaited<TCallbackResult>> {
    const runner = this
    // A function expression keeps the caller's receiver available to forward.
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
  private async enterLayers(
    parent: ScopeContext,
    callback: LayerCallback,
  ): Promise<unknown> {
    const enter = (scope: ScopeContext) =>
      withChildScope(scope, this.factory(), callback)
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
 * Replaces one dependency with a value for the duration of a callback.
 *
 * Create it with `createValueOverride` for a dependency that application code
 * replaces the same way again and again.
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
