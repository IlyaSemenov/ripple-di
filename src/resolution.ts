import { isPromise } from "node:util/types"

import { nodeOf } from "./dependency"
import {
  AsyncFactoryError,
  CrossRuntimeDependencyError,
  CrossScopeResolutionError,
  DependencyCycleError,
  DisposerContextError,
  FactoryError,
  MissingProviderError,
  RippleError,
  ScopeClosedError,
} from "./errors"
import type { EvaluationFrame, TrackingFrame } from "./evaluation"
import {
  currentTracking,
  cycleStart,
  framesFrom,
  popEvaluation,
  pushEvaluation,
  resolutionPath,
} from "./evaluation"
import type {
  BindingStamp,
  BoundProvider,
  Cell,
  DependencyIdentityRecord,
  DependencyNode,
  DependencyStamp,
  ResolutionRef,
  ScopeContext,
} from "./graph"
import { scopeParent } from "./graph"
import { markedValueOf } from "./value"

/** Internal resolution failure that must not be attributed to a user factory. */
class ResolutionInvariantError extends RippleError {
  constructor(message: string) {
    super(`Internal ripple-di resolution invariant failed: ${message}`)
    this.name = "ResolutionInvariantError"
  }
}

/** Public and callable reads are tracked against the frame that initiated them. */
export function resolveTracked<T>(
  scope: ScopeContext,
  node: DependencyNode<T>,
): T {
  const consumerFrame = currentTracking()

  try {
    assertCompatible(scope, node)
    if (consumerFrame?.runtime && consumerFrame.runtime !== scope.runtime) {
      throw new CrossRuntimeDependencyError(
        node.name,
        node.runtime.name,
        consumerFrame.runtime.name,
      )
    }
    assertPubliclyReadable(scope, node.name)
    if (consumerFrame?.scope && consumerFrame.scope !== scope) {
      throw new CrossScopeResolutionError(
        node.name,
        consumerFrame.scope.name,
        scope.name,
      )
    }
    if (consumerFrame) {
      consumerFrame.runtime = scope.runtime
      consumerFrame.scope = scope
    }

    const resolved = resolveUntracked(scope, node)
    if (consumerFrame) {
      recordDependency(consumerFrame, node, resolved.stamp)
    }
    return resolved.value
  } catch (error) {
    if (consumerFrame) {
      consumerFrame.hasFailedDependencyRead = true
    }
    throw error
  }
}

/**
 * Resolves without creating a dependency edge.
 *
 * Ancestor validation uses this path so implementation reads never become
 * dependencies of the consumer factory currently on the synchronous stack.
 */
export function resolveUntracked<T>(
  requestedScope: ScopeContext,
  node: DependencyNode<T>,
): ResolutionRef<T> {
  assertCompatible(requestedScope, node)

  const cached = requestedScope.viewCache.get(asUnknownNode(node))
  if (cached) {
    const typed = cached as ResolutionRef<T>
    assertUsableRef(typed, node, requestedScope)
    return typed
  }

  const provider = findEffectiveProvider(requestedScope, node)
  if (!provider || provider.spec.kind === "missing") {
    throw new MissingProviderError(
      node.name,
      resolutionPath(asUnknownNode(node)),
    )
  }

  if (provider.spec.kind === "value" || provider.spec.kind === "owned-value") {
    const resolved: ResolutionRef<T> = {
      value: provider.spec.value,
      stamp: provider.stamp,
    }
    requestedScope.viewCache.set(
      asUnknownNode(node),
      resolved as ResolutionRef<unknown>,
    )
    return resolved
  }

  const reusable = findReusableAncestorCell(requestedScope, node, provider)
  if (reusable) {
    requestedScope.viewCache.set(asUnknownNode(node), reusable as Cell<unknown>)
    return reusable
  }

  return materialize(requestedScope, node, provider)
}

function findEffectiveProvider<T>(
  scope: ScopeContext,
  node: DependencyNode<T>,
): BoundProvider<T> | undefined {
  for (
    let cursor: ScopeContext | undefined = scope;
    cursor;
    cursor = cursor[scopeParent]
  ) {
    const explicit = cursor.bindings.get(asUnknownNode(node))
    if (explicit) {
      return explicit as BoundProvider<T>
    }
  }
  return scope.runtime.getDefaultProvider(node)
}

function findReusableAncestorCell<T>(
  requestedScope: ScopeContext,
  node: DependencyNode<T>,
  provider: BoundProvider<T>,
): Cell<T> | undefined {
  for (
    let cursor = requestedScope[scopeParent];
    cursor;
    cursor = cursor[scopeParent]
  ) {
    const candidate = cursor.ownedCells.get(asUnknownNode(node)) as
      | Cell<T>
      | undefined
    if (candidate && isReusable(candidate, provider, requestedScope)) {
      return candidate
    }
  }
}

function isReusable<T>(
  cell: Cell<T>,
  provider: BoundProvider<T>,
  requestedScope: ScopeContext,
): boolean {
  if (
    cell.state !== "ready" ||
    !cell.reusable ||
    (cell.owner.state !== "active" && cell.owner.state !== "retiring") ||
    cell.providerStamp.identity !== provider.stamp.identity
  ) {
    return false
  }

  for (const record of cell.dependencies) {
    try {
      const dependencyNode = nodeOf(record.dependency)
      const actual = resolveUntracked(requestedScope, dependencyNode)
      if (actual.stamp.identity !== record.stamp.identity) {
        return false
      }
    } catch {
      return false
    }
  }
  return true
}

function materialize<T>(
  requestedScope: ScopeContext,
  node: DependencyNode<T>,
  provider: BoundProvider<T>,
): Cell<T> {
  if (provider.spec.kind !== "factory") {
    throw new Error(
      "ripple-di attempted to materialize a non-factory provider.",
    )
  }

  const start = cycleStart(asUnknownNode(node), provider.stamp as BindingStamp)
  if (start >= 0) {
    const path = framesFrom(start).map((frame) => frame.node.name)
    throw new DependencyCycleError([...path, node.name])
  }

  const frame: EvaluationFrame = {
    kind: "factory",
    name: node.name,
    runtime: requestedScope.runtime,
    scope: requestedScope,
    node: asUnknownNode(node),
    providerStamp: provider.stamp as BindingStamp,
    dependencies: new Map(),
    hasFailedDependencyRead: false,
  }

  pushEvaluation(frame)
  let value: T
  try {
    const produced = provider.spec.factory()
    const marked = markedValueOf(produced)
    if (marked) {
      value = marked.value as T
    } else if (isPromise(produced)) {
      throw new AsyncFactoryError(node.name, resolutionPath())
    } else {
      value = produced as T
    }
  } catch (error) {
    if (error instanceof RippleError) {
      throw error
    }
    throw new FactoryError(node.name, resolutionPath(), error)
  } finally {
    popEvaluation(frame)
  }

  const dependencies = [...frame.dependencies].map(
    ([dependencyNode, stamp]) => ({
      dependency: dependencyNode.dependency,
      stamp,
    }),
  )

  const reusable = !frame.hasFailedDependencyRead
  const owner = !reusable
    ? requestedScope
    : deepestScope([
        provider.stamp.home,
        ...dependencies.map((record) => record.stamp.home),
      ])

  if (!isAncestorOrSelf(owner, requestedScope)) {
    throw new Error(
      `ripple-di owner invariant failed for dependency "${node.name}".`,
    )
  }

  const cell: Cell<T> = {
    dependency: node.dependency,
    node,
    value,
    owner,
    stamp: {
      kind: "cell",
      identity: Symbol(`${node.name}:cell`),
      dependency: node.dependency,
      home: owner,
    },
    providerStamp: provider.stamp,
    dependencies,
    reusable,
    state: "ready",
  }
  owner.publish(cell, requestedScope)
  return cell
}

function recordDependency<T>(
  frame: TrackingFrame,
  node: DependencyNode<T>,
  stamp: DependencyStamp<T>,
): void {
  const unknownNode = asUnknownNode(node)
  const previous = frame.dependencies.get(unknownNode)
  if (previous && previous.identity !== stamp.identity) {
    throw new ResolutionInvariantError(
      `Dependency "${node.name}" changed identity while evaluating ` +
        `"${frame.name}".`,
    )
  }
  frame.dependencies.set(unknownNode, stamp as DependencyStamp)
}

/** Reuses and propagates a previously tracked dependency set when it matches. */
export function reuseTrackedDependencies(
  dependencies: readonly DependencyIdentityRecord[],
): boolean {
  const first = dependencies[0]
  if (!first) {
    return true
  }

  const firstNode = nodeOf(first.dependency)
  const consumerFrame = currentTracking()
  if (consumerFrame?.runtime && consumerFrame.runtime !== firstNode.runtime) {
    return false
  }
  const scope = consumerFrame?.scope ?? firstNode.runtime.currentAmbientScope()

  const resolvedDependencies: Array<{
    node: DependencyNode<unknown>
    stamp: DependencyStamp
  }> = []
  try {
    for (const record of dependencies) {
      const node = nodeOf(record.dependency)
      assertCompatible(scope, node)
      assertPubliclyReadable(scope, node.name)
      const actual = resolveUntracked(scope, node)
      if (actual.stamp.identity !== record.identity) {
        return false
      }
      resolvedDependencies.push({ node, stamp: actual.stamp })
    }
  } catch {
    return false
  }

  if (consumerFrame) {
    consumerFrame.runtime = scope.runtime
    consumerFrame.scope = scope
    for (const dependency of resolvedDependencies) {
      recordDependency(consumerFrame, dependency.node, dependency.stamp)
    }
  }
  return true
}

/** Propagates a completed nested computation into its consumer frame. */
export function propagateTrackedDependencies(
  source: TrackingFrame,
  consumer: TrackingFrame | undefined,
): void {
  if (!consumer) {
    return
  }
  if (source.hasFailedDependencyRead) {
    consumer.hasFailedDependencyRead = true
  }
  if (!source.runtime || !source.scope) {
    return
  }
  if (consumer.runtime && consumer.runtime !== source.runtime) {
    const dependency = source.dependencies.keys().next().value
    if (dependency) {
      throw new CrossRuntimeDependencyError(
        dependency.name,
        dependency.runtime.name,
        consumer.runtime.name,
      )
    }
    return
  }
  if (consumer.scope && consumer.scope !== source.scope) {
    const dependency = source.dependencies.keys().next().value
    if (dependency) {
      throw new CrossScopeResolutionError(
        dependency.name,
        consumer.scope.name,
        source.scope.name,
      )
    }
    return
  }

  consumer.runtime = source.runtime
  consumer.scope = source.scope
  for (const [node, stamp] of source.dependencies) {
    recordDependency(consumer, node, stamp)
  }
}

function assertCompatible<T>(
  scope: ScopeContext,
  node: DependencyNode<T>,
): void {
  if (scope.runtime !== node.runtime) {
    throw new CrossRuntimeDependencyError(
      node.name,
      node.runtime.name,
      scope.runtime.name,
    )
  }
}

function assertPubliclyReadable(
  scope: ScopeContext,
  dependencyName: string,
): void {
  const owner = scope.runtime.teardown.getStore()
  if (owner) {
    throw new DisposerContextError(dependencyName, owner.name, owner.id)
  }
  if (scope.state !== "active") {
    throw new ScopeClosedError(
      dependencyName,
      scope.name,
      scope.id,
      scope.state,
    )
  }
}

function assertUsableRef<T>(
  resolved: ResolutionRef<T>,
  node: DependencyNode<T>,
  requestedScope: ScopeContext,
): void {
  if (resolved.stamp.kind !== "cell") {
    return
  }
  const cell = resolved as Cell<T>
  if (
    cell.state !== "ready" ||
    (cell.owner.state !== "active" && cell.owner.state !== "retiring")
  ) {
    throw new ScopeClosedError(
      node.name,
      requestedScope.name,
      requestedScope.id,
      requestedScope.state,
    )
  }
}

function deepestScope(scopes: readonly ScopeContext[]): ScopeContext {
  return scopes.reduce((deepest, scope) =>
    scope.depth > deepest.depth ? scope : deepest,
  )
}

function isAncestorOrSelf(
  ancestor: ScopeContext,
  scope: ScopeContext,
): boolean {
  for (
    let cursor: ScopeContext | undefined = scope;
    cursor;
    cursor = cursor[scopeParent]
  ) {
    if (cursor === ancestor) {
      return true
    }
  }
  return false
}

function asUnknownNode<T>(node: DependencyNode<T>): DependencyNode<unknown> {
  return node as DependencyNode<unknown>
}
