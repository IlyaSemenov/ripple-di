import type { Dependency, Disposer } from "./dependency"
import { nodeOf } from "./dependency"
import { OwnedProvisionReuseError } from "./errors"
import type { ProviderSpec } from "./graph"

declare const provisionBrand: unique symbol

/**
 * A value or factory prepared for installation in a scope.
 *
 * Create provisions with `provide` or `provideFactory`.
 */
export interface Provision {
  readonly [provisionBrand]: true
}

/** Ownership options for an existing value supplied with `provide`. */
export interface ProvideOptions<T> {
  /**
   * Cleanup called when the receiving scope closes.
   *
   * Pass `true` to use the Dependency's cleanup callback, or pass a different
   * callback explicitly.
   * Either form transfers ownership of the value to Ripple DI.
   */
  readonly dispose?: Disposer<T> | true
}

export interface ProvisionRecord<T> {
  readonly dependency: Dependency<T>
  readonly spec: ProviderSpec<T>
}

const provisionRecords = new WeakMap<object, ProvisionRecord<unknown>>()
const claimedOwnedProvisions = new WeakSet<object>()

function createProvision<T>(
  dependency: Dependency<T>,
  spec: ProviderSpec<T>,
): Provision {
  nodeOf(dependency)
  const provision = {} as Provision
  provisionRecords.set(provision, {
    dependency,
    spec,
  } as ProvisionRecord<unknown>)
  return provision
}

export function provisionOf(provision: Provision): ProvisionRecord<unknown> {
  const record = provisionRecords.get(provision)
  if (!record) {
    throw new TypeError(
      "Value is not a Provision created by this copy of ripple-di. " +
        "If it came from ripple-di, the package may be installed or bundled " +
        "more than once.",
    )
  }
  return record
}

/**
 * Transfers each owned-value Provision to one Scope after list validation.
 *
 * Checking the complete list before recording claims keeps failed Scope
 * creation atomic.
 */
export function claimOwnedProvisions(provisions: readonly Provision[]): void {
  const owned = provisions.filter(
    (provision) => provisionOf(provision).spec.kind === "owned-value",
  )

  for (const provision of owned) {
    if (claimedOwnedProvisions.has(provision)) {
      const record = provisionOf(provision)
      throw new OwnedProvisionReuseError(nodeOf(record.dependency).name)
    }
  }
  for (const provision of owned) {
    claimedOwnedProvisions.add(provision)
  }
}

/**
 * Uses an existing value for a Dependency in a scope.
 *
 * Ripple DI cleans up the value only when `options.dispose` is provided.
 * Pass `true` to reuse cleanup configured by `defineResource`, or pass a
 * callback to override it.
 * A function passed as the value remains a value rather than becoming a factory.
 * A Provision that transfers ownership can be installed in only one Scope.
 */
export function provide<T>(
  dependency: Dependency<T>,
  value: NoInfer<T>,
  options: ProvideOptions<NoInfer<T>> = {},
): Provision {
  if (options.dispose) {
    const node = nodeOf(dependency)
    const dispose = options.dispose === true ? node.dispose : options.dispose
    if (!dispose) {
      throw new TypeError(
        `Dependency "${node.name}" has no dispose callback to reuse.`,
      )
    }
    return createProvision(dependency, {
      kind: "owned-value",
      value,
      dispose,
    })
  }
  return createProvision(dependency, {
    kind: "value",
    value,
  })
}

/**
 * Creates a Dependency override on demand in the receiving scope.
 *
 * The factory must be synchronous.
 * Calls to other Dependencies inside it are tracked automatically.
 * The receiving scope owns the created value.
 * When the Dependency was defined with `defineResource` and a `dispose`
 * callback, that callback cleans up the override when the scope closes.
 */
export function provideFactory<T>(
  dependency: Dependency<T>,
  factory: () => NoInfer<T>,
): Provision {
  return createProvision(dependency, { kind: "factory", factory })
}
