import type {
  DependencyKind,
  DependencyNode,
  ProviderSpec,
  RuntimeContext,
} from "./graph"

declare const dependencyBrand: unique symbol

/**
 * A function that returns the dependency value for the current scope.
 *
 * Pass the same function to `provide` to replace its value or to
 * `scope.resolve` when you need to read from a specific scope.
 */
export type Dependency<T> = (() => T) & {
  readonly [dependencyBrand]: (value: T) => T
}

/** Cleans up a value when Ripple DI no longer needs it. */
export type Disposer<T> = (value: T) => void | Promise<void>

/** Options for a value supplied at a scope boundary. */
export interface SlotOptions<T> {
  /** Optional name used only in error messages and resolution paths. */
  readonly name?: string
  /** Value factory used when no scope supplies this slot. */
  readonly default?: () => T
}

/** Options for a value calculated from other dependencies. */
export interface ComputedOptions {
  /** Optional name used only in error messages and resolution paths. */
  readonly name?: string
}

/** Optional diagnostics and cleanup for a lazily created service. */
export interface ResourceOptions<T> {
  /** Optional name used only in error messages and resolution paths. */
  readonly name?: string
  /** Cleanup called when the scope that created the resource closes. */
  readonly dispose?: Disposer<T>
}

let nextDependencyId = 1
const dependencyNodes = new WeakMap<object, DependencyNode<unknown>>()

/** Complete private recipe used to create one callable Dependency definition. */
interface DependencyDefinition<T> {
  readonly name: string | undefined
  readonly kind: DependencyKind
  readonly runtime: RuntimeContext
  readonly defaultSpec: ProviderSpec<T> | undefined
  readonly dispose: DependencyNode<T>["dispose"]
}

/** Fully initialized metadata object captured by its own callable Dependency. */
class DependencyNodeImpl<T> implements DependencyNode<T> {
  readonly id = nextDependencyId++
  readonly name: string
  readonly kind: DependencyKind
  readonly runtime: RuntimeContext
  readonly defaultSpec: ProviderSpec<T> | undefined
  readonly dispose: DependencyNode<T>["dispose"]
  readonly dependency: Dependency<T>

  constructor(definition: DependencyDefinition<T>) {
    this.kind = definition.kind
    this.name = definition.name ?? `${definition.kind}#${this.id}`
    this.runtime = definition.runtime
    this.defaultSpec = definition.defaultSpec
    this.dispose = definition.dispose
    this.dependency = (() => this.runtime.readCallable(this)) as Dependency<T>
  }
}

/** Creates a property-free callable whose metadata lives only in a WeakMap. */
export function createDependency<T>(
  definition: DependencyDefinition<T>,
): Dependency<T> {
  const node = new DependencyNodeImpl(definition)
  dependencyNodes.set(node.dependency, node as DependencyNode<unknown>)
  return node.dependency
}

export function nodeOf<T>(dependency: Dependency<T>): DependencyNode<T> {
  const node = dependencyNodes.get(dependency)
  if (!node) {
    throw new TypeError(
      "Value is not a Dependency created by this copy of ripple-di. " +
        "If it came from ripple-di, the package may be installed or bundled " +
        "more than once.",
    )
  }
  return node as DependencyNode<T>
}
