import type { DependencyNode, RuntimeContext } from "./graph"
import type { FactoryResult } from "./value"

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

/** Optional diagnostics and cleanup for a dependency. */
export interface DependencyOptions<T> {
  /** Optional name used only in error messages and resolution paths. */
  readonly name?: string
  /**
   * Cleans up values owned by Ripple DI.
   *
   * This applies to the built-in factory, `provideFactory`, and values passed
   * through `provide` with `dispose: true`.
   * Plain values passed through `provide` remain borrowed.
   */
  readonly dispose?: Disposer<T>
}

let nextDependencyId = 1
const dependencyNodes = new WeakMap<object, DependencyNode<unknown>>()

/** Complete private recipe used to create one callable dependency definition. */
interface DependencyDefinition<T> {
  readonly name: string | undefined
  readonly runtime: RuntimeContext
  readonly defaultFactory: (() => FactoryResult<T>) | undefined
  readonly dispose: DependencyNode<T>["dispose"]
}

/** Fully initialized metadata object captured by its own callable dependency. */
class DependencyNodeImpl<T> implements DependencyNode<T> {
  readonly id = nextDependencyId++
  readonly name: string
  readonly runtime: RuntimeContext
  readonly defaultFactory: (() => FactoryResult<T>) | undefined
  readonly dispose: DependencyNode<T>["dispose"]
  readonly dependency: Dependency<T>

  constructor(definition: DependencyDefinition<T>) {
    this.name = definition.name ?? `dependency#${this.id}`
    this.runtime = definition.runtime
    this.defaultFactory = definition.defaultFactory
    this.dispose = definition.dispose
    this.dependency = (() => this.runtime.readCallable(this)) as Dependency<T>
  }
}

/** Creates a property-free callable whose metadata lives only in a `WeakMap`. */
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
      "Value is not a dependency created by this copy of ripple-di. " +
        "If it came from ripple-di, the package may be installed or bundled " +
        "more than once.",
    )
  }
  return node as DependencyNode<T>
}
