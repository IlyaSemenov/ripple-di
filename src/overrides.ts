import type { RuntimeContext, ScopeContext } from "./graph"
import type { Provision } from "./provide"
import { type Scope, withChildScope } from "./scope"

/** Builds the provisions used by one call. */
export type ProvisionFactory = () => readonly Provision[]

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
  run<R>(callback: (scope: Scope) => R | Promise<R>): Promise<Awaited<R>>
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

  run<R>(callback: (scope: Scope) => R | Promise<R>): Promise<Awaited<R>> {
    this.runtime.assertScopeManagementAllowed("OverrideRunner.run")
    // The innermost layer produces the result of the whole chain.
    return this.enterLayers(
      this.runtime.currentAmbientScope(),
      callback,
    ) as Promise<Awaited<R>>
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
