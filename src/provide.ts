import type { DependencyToken, Disposer } from "./dependency"
import { nodeOf } from "./dependency"
import { OwnedProvisionReuseError } from "./errors"
import type { ProviderSpec } from "./graph"
import { foreignMetadataError } from "./sharing"
import { type FactoryResult, markedValueOf } from "./value"

declare const provisionBrand: unique symbol

/**
 * A value, factory, or removal of a dependency for `install`, `withOverrides`,
 * and other functions that accept overrides.
 *
 * Create it with `provide`, `provideFactory`, or `withoutProvider`.
 */
export interface Provision {
  readonly [provisionBrand]: true
}

/** One provision or a list of them. */
export type ProvisionInput = Provision | readonly Provision[]

/**
 * Provisions accepted by `install` and `collectProvisions`, which skip
 * `false`, `null`, and `undefined`.
 */
export type ProvisionCollectionInput = ProvisionInput | false | null | undefined

/** Options for `provide`. */
export interface ProvideOptions<T> {
  /**
   * Hands the value over to the receiving scope or installation, which cleans
   * it up when it closes.
   *
   * Pass `true` to use the dependency's own `dispose`, or a callback to clean
   * up this value differently.
   */
  readonly dispose?: Disposer<T> | true
}

/** Private dependency and provider recipe carried by an opaque provision. */
export interface ProvisionRecord<T> {
  readonly dependency: DependencyToken<T>
  readonly spec: ProviderSpec<T>
}

const provisionRecords = new WeakMap<object, ProvisionRecord<unknown>>()
const claimedOwnedProvisions = new WeakSet<object>()

function createProvision<T>(dependency: DependencyToken<T>, spec: ProviderSpec<T>): Provision {
  // Validate package-copy identity before returning a provision.
  nodeOf(dependency)
  const provision = {} as Provision
  provisionRecords.set(provision, {
    dependency,
    spec,
  } as ProvisionRecord<unknown>)
  return provision
}

/** Reads private metadata; rejects provisions not created by this package copy. */
export function provisionOf(provision: Provision): ProvisionRecord<unknown> {
  const record = provisionRecords.get(provision)
  if (!record) {
    throw foreignMetadataError("provision")
  }
  return record
}

/** Reads provision input as the list the rest of the library works with. */
export function provisionListOf(input: ProvisionInput): readonly Provision[] {
  return Array.isArray(input) ? input : [input as Provision]
}

/**
 * Combines provisions and lists of them into one list.
 *
 * `false`, `null`, and `undefined` are skipped, so provisions can be included
 * conditionally.
 */
export function collectProvisions(
  ...inputs: readonly ProvisionCollectionInput[]
): readonly Provision[] {
  return inputs.flatMap(input => {
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
  const owned = provisions.filter(provision => provisionOf(provision).spec.kind === "owned-value")

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
 * Provides an existing value for a dependency.
 *
 * The value stays yours unless `options.dispose` hands it over to the
 * receiving scope or installation; a handed-over value belongs to that owner
 * only.
 * A function passed as the value is the value itself; use `provideFactory` to
 * build the value instead.
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
      throw new TypeError(`Dependency "${node.name}" has no cleanup configuration to reuse.`)
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
 * Provides a factory that builds the dependency's value on first use in the
 * receiving scope or installation.
 *
 * The factory is synchronous, and the dependencies it calls are recorded like
 * those of a built-in factory.
 * The receiving scope or installation cleans up the value with the
 * dependency's `dispose`.
 */
export function provideFactory<T>(
  dependency: DependencyToken<T>,
  factory: () => FactoryResult<NoInfer<T>>,
): Provision {
  return createProvision(dependency, { kind: "factory", factory })
}

/**
 * Makes a dependency unavailable in the receiving scope or installation, even
 * when an outer scope or the dependency's own factory would supply it.
 *
 * Calling the dependency there throws `MissingProviderError`, and a nested
 * scope can provide it again.
 * Existing values are not cleaned up.
 */
export function withoutProvider<T>(dependency: DependencyToken<T>): Provision {
  return createProvision(dependency, { kind: "missing" })
}
