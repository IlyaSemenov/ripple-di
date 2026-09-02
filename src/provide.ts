import type { DependencyToken, Disposer } from "./dependency"
import { nodeOf } from "./dependency"
import { OwnedProvisionReuseError } from "./errors"
import type { ProviderSpec } from "./graph"
import { type FactoryResult, markedValueOf } from "./value"

declare const provisionBrand: unique symbol

/**
 * A value or factory prepared for a scope or runtime installation.
 *
 * Create provisions with `provide` or `provideFactory`.
 */
export interface Provision {
  readonly [provisionBrand]: true
}

/** One provision or a list accepted by scopes, installations, and overrides. */
export type ProvisionInput = Provision | readonly Provision[]

/** One provision input or an absent conditional branch being collected. */
export type ProvisionCollectionInput = ProvisionInput | false | null | undefined

/** Ownership options for an existing value supplied with `provide`. */
export interface ProvideOptions<T> {
  /**
   * Cleanup called when the receiving scope or installation closes.
   *
   * Pass `true` to reuse the dependency's cleanup configuration, or pass a
   * different callback explicitly.
   * Either form transfers ownership of the value to Ripple DI.
   */
  readonly dispose?: Disposer<T> | true
}

export interface ProvisionRecord<T> {
  readonly dependency: DependencyToken<T>
  readonly spec: ProviderSpec<T>
}

const provisionRecords = new WeakMap<object, ProvisionRecord<unknown>>()
const claimedOwnedProvisions = new WeakSet<object>()

function createProvision<T>(
  dependency: DependencyToken<T>,
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
      "Value is not a provision created by this copy of ripple-di. " +
        "If it came from ripple-di, the package may be installed or bundled " +
        "more than once.",
    )
  }
  return record
}

/** Reads provision input as the list the rest of the library works with. */
export function provisionListOf(input: ProvisionInput): readonly Provision[] {
  return Array.isArray(input) ? input : [input as Provision]
}

/**
 * Collects individual provisions and provision lists into one flat list.
 *
 * False and nullish inputs are omitted so provisions can be included
 * conditionally without temporary arrays.
 */
export function collectProvisions(
  ...inputs: readonly ProvisionCollectionInput[]
): readonly Provision[] {
  return inputs.flatMap((input) => {
    if (input === false || input === null || input === undefined) {
      return []
    }
    return provisionListOf(input)
  })
}

/**
 * Transfers each owned-value provision to one owner after list validation.
 *
 * Checking the complete list before recording claims keeps failed scope
 * creation atomic.
 */
export function claimOwnedProvisions<TPrepared>(
  provisions: readonly Provision[],
  prepare: () => TPrepared,
): TPrepared {
  const owned = provisions.filter(
    (provision) => provisionOf(provision).spec.kind === "owned-value",
  )

  for (const provision of owned) {
    if (claimedOwnedProvisions.has(provision)) {
      const record = provisionOf(provision)
      throw new OwnedProvisionReuseError(nodeOf(record.dependency).name)
    }
  }

  // Preparation may inspect a user value and throw. Run it after reuse
  // validation but before recording claims so the whole operation stays atomic.
  const prepared = prepare()
  for (const provision of owned) {
    claimedOwnedProvisions.add(provision)
  }
  return prepared
}

/**
 * Uses an existing value for a dependency in a scope or installation.
 *
 * Ripple DI cleans up the value only when `options.dispose` is provided.
 * Pass `true` to reuse cleanup configured by `defineDependency`, or pass a
 * callback to override it.
 * A function passed as the value remains a value rather than becoming a factory.
 * A provision that transfers ownership can be used in only one scope or
 * installation.
 */
export function provide<T>(
  dependency: DependencyToken<T>,
  value: NoInfer<T>,
  options: ProvideOptions<NoInfer<T>> = {},
): Provision {
  if (markedValueOf(value)) {
    throw new TypeError(
      `Dependency "${nodeOf(dependency).name}" was given an asValue() ` +
        "marker instead of a value. Pass the value itself to provide(), or " +
        "return the marker from provideFactory().",
    )
  }
  if (options.dispose) {
    const node = nodeOf(dependency)
    const dispose = options.dispose === true ? node.dispose : options.dispose
    if (!dispose) {
      throw new TypeError(
        `Dependency "${node.name}" has no cleanup configuration to reuse.`,
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
 * Creates a dependency override on demand in the receiving scope or
 * installation.
 *
 * The factory must be synchronous.
 * Calls to other dependencies inside it are tracked automatically.
 * The receiving scope or installation owns the created value.
 * When the dependency has configured cleanup, it cleans up the override when
 * its owner closes.
 */
export function provideFactory<T>(
  dependency: DependencyToken<T>,
  factory: () => FactoryResult<NoInfer<T>>,
): Provision {
  return createProvision(dependency, { kind: "factory", factory })
}
