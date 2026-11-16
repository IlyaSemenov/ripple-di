import { type DependencyToken, nodeOf } from "./dependency"
import type { Cell, DependencyNode, ResolutionRef, ScopeContext } from "./graph"
import { resolveTrackedRef } from "./resolution"

/** A dependency that a value was built from, directly or through other dependencies. */
export interface DependencyInput {
  // `any` admits a dependency of every value type, which `unknown` does not,
  // so tests can compare this with their own dependencies.
  readonly dependency: DependencyToken<any>
  /** Name shown in error messages. */
  readonly name: string
  /**
   * Names of the dependencies that lead from the inspected one to this input,
   * including both.
   */
  readonly path: readonly string[]
}

/** How the value of a dependency in the current scope was built. */
export interface DependencyInspection {
  /**
   * Every dependency the value was built from, nearest first.
   *
   * A scope that overrides any of them gets a value of its own.
   * Empty for a value supplied with `provide`.
   */
  readonly inputs: readonly DependencyInput[]
}

/**
 * Resolves a dependency like `resolveTracked` and lists the inputs its value
 * was built from.
 *
 * After resolving the inspected dependency, the walk follows only the inputs
 * recorded when each value was built and resolves nothing else.
 */
export function inspectTracked<T>(
  scope: ScopeContext,
  node: DependencyNode<T>,
): DependencyInspection {
  const unknownNode = node as DependencyNode<unknown>
  const inputs: DependencyInput[] = []
  const visited = new Set([unknownNode.dependency])
  // Breadth-first, so each input reports its shortest path.
  const queue: Array<{ resolved: ResolutionRef<unknown>; path: readonly string[] }> = [
    { resolved: resolveTrackedRef(scope, unknownNode), path: [node.name] },
  ]
  for (let entry = queue.shift(); entry; entry = queue.shift()) {
    if (entry.resolved.stamp.kind !== "cell") {
      continue
    }
    for (const record of (entry.resolved as Cell<unknown>).dependencies) {
      if (visited.has(record.dependency)) {
        continue
      }
      visited.add(record.dependency)
      const name = nodeOf(record.dependency).name
      const path = [...entry.path, name]
      inputs.push({ dependency: record.dependency, name, path })
      queue.push({ resolved: record.resolved, path })
    }
  }
  return { inputs }
}
