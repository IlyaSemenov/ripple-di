import { cleanupOf, type DependencyToken, nodeOf } from "./dependency"
import {
  CrossRuntimeDependencyError,
  DetachedContextOwnedProvisionError,
  DuplicateProviderError,
  LeakedChildScopeError,
  ScopeClosedError,
} from "./errors"
import type {
  BoundProvider,
  Cell,
  DependencyNode,
  Finalizer,
  ResolutionRef,
  RuntimeContext,
  ScopeContext,
} from "./graph"
import { scopeParent } from "./graph"
import {
  claimOwnedProvisions,
  type Provision,
  type ProvisionInput,
  type ProvisionRecord,
  provide,
  provideFactory,
  provisionListOf,
  provisionOf,
  withoutProvider,
} from "./provide"
import { resolveTracked } from "./resolution"

/** Current lifecycle phase of a scope. */
export type ScopeState = "active" | "retiring" | "closing" | "closed"

/**
 * An isolated view of dependency values that inherits from a parent scope.
 *
 * A scope can replace selected dependencies without changing its parent.
 * Scope management and lifecycle methods cannot be called from a dependency
 * factory or disposer in the same runtime.
 */
export interface Scope extends AsyncDisposable {
  /** Returns a dependency value explicitly from this scope. */
  resolve<T>(dependency: DependencyToken<T>): T
  /** Creates a child scope with optional dependency overrides. */
  createScope(provisions?: ProvisionInput): Scope
  /** Makes this scope current while the callback runs without closing it. */
  run<TCallbackResult>(callback: () => TCallbackResult): TCallbackResult
  /** Runs a callback in a temporary child scope and cleans it up afterward. */
  withOverrides<TCallbackResult>(
    provisions: ProvisionInput,
    callback: (scope: Scope) => TCallbackResult,
  ): Promise<Awaited<TCallbackResult>>
  /** Waits for existing child scopes before cleaning up this scope. */
  retire(): Promise<void>
  /** Closes all child scopes and then cleans up this scope. */
  close(): Promise<void>
}

interface LifecycleDeferred {
  readonly promise: Promise<void>
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
}

let nextScopeId = 1

/**
 * Immutable binding overlay and physical owner of locally published cells.
 *
 * The binding Map is populated only during construction, while caches,
 * children, finalizers, and lifecycle state evolve until teardown completes.
 */
export class ScopeImpl implements ScopeContext {
  readonly id = nextScopeId++
  readonly name: string
  readonly depth: number
  readonly bindings = new Map<DependencyNode<unknown>, BoundProvider<unknown>>()
  readonly viewCache = new Map<
    DependencyNode<unknown>,
    ResolutionRef<unknown>
  >()
  readonly ownedCells = new Map<DependencyNode<unknown>, Cell<unknown>>()
  readonly finalizers: Finalizer[] = []
  readonly children = new Set<ScopeContext>()
  state: ScopeState = "active"

  private readonly lifecycle = createDeferred()
  private closingStarted = false
  readonly [scopeParent]: ScopeImpl | undefined

  constructor(
    readonly runtime: RuntimeContext,
    parent: ScopeImpl | undefined,
    records: readonly ProvisionRecord<unknown>[],
  ) {
    this[scopeParent] = parent
    this.depth = parent ? parent.depth + 1 : 0
    this.name = `${runtime.name}/scope-${this.id}`

    for (const record of records) {
      this.install(record)
    }
    parent?.children.add(this)
  }

  resolve<T>(dependency: DependencyToken<T>): T {
    const node = nodeOf(dependency)
    return resolveTracked(this, node)
  }

  createScope(provisions: ProvisionInput = []): ScopeImpl {
    this.runtime.assertScopeManagementAllowed("Scope.createScope")
    this.assertActive("<createScope>")
    const records = validateProvisions(
      this.runtime,
      provisionListOf(provisions),
    )
    return new ScopeImpl(this.runtime, this, records)
  }

  run<TCallbackResult>(callback: () => TCallbackResult): TCallbackResult {
    this.runtime.assertScopeManagementAllowed("Scope.run")
    this.assertActive("<run>")
    return this.runtime.ambient.run(this, callback)
  }

  withOverrides<TCallbackResult>(
    provisions: ProvisionInput,
    callback: (scope: Scope) => TCallbackResult,
  ): Promise<Awaited<TCallbackResult>> {
    this.runtime.assertScopeManagementAllowed("Scope.withOverrides")
    return withChildScope(this, provisions, callback)
  }

  retire(): Promise<void> {
    this.runtime.assertScopeManagementAllowed("Scope.retire")
    if (this.state === "active") {
      this.state = "retiring"
      if (this.children.size === 0) {
        this.beginClose(false)
      }
    }
    return this.lifecycle.promise
  }

  close(): Promise<void> {
    this.runtime.assertScopeManagementAllowed("Scope.close")
    if (this.state !== "closed" && this.state !== "closing") {
      this.state = "closing"
      this.beginClose(true)
    }
    return this.lifecycle.promise
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }

  publish<T>(cell: Cell<T>, requestedScope: ScopeContext): void {
    if (this.state !== "active" && this.state !== "retiring") {
      throw new ScopeClosedError(cell.node.name, this.name, this.id, this.state)
    }

    // Prepare cleanup before publishing so an invalid standard disposer cannot
    // leave a partially cached cell behind.
    const finalizer = cell.node.dispose
      ? {
          cell: cell as Cell<unknown>,
          run: cleanupOf(cell.node.name, cell.value, cell.node.dispose),
        }
      : undefined

    this.ownedCells.set(
      cell.node as DependencyNode<unknown>,
      cell as Cell<unknown>,
    )
    this.viewCache.set(
      cell.node as DependencyNode<unknown>,
      cell as ResolutionRef<unknown>,
    )
    requestedScope.viewCache.set(
      cell.node as DependencyNode<unknown>,
      cell as ResolutionRef<unknown>,
    )

    if (finalizer) {
      this.finalizers.push(finalizer)
    }
  }

  private install(record: ProvisionRecord<unknown>): void {
    const node = nodeOf(record.dependency)
    const bound: BoundProvider<unknown> = {
      spec: record.spec,
      stamp: {
        kind: "binding",
        identity: Symbol(`${node.name}:binding`),
        dependency: record.dependency,
        home: this,
      },
    }
    this.bindings.set(node, bound)

    if (record.spec.kind === "owned-value") {
      const { dispose, value } = record.spec
      this.finalizers.push({
        run: cleanupOf(node.name, value, dispose),
      })
    }
  }

  private assertActive(operation: string): void {
    if (this.state !== "active") {
      throw new ScopeClosedError(operation, this.name, this.id, this.state)
    }
  }

  private beginClose(force: boolean): void {
    if (this.closingStarted) {
      return
    }
    this.closingStarted = true
    this.state = "closing"
    void this.performClose(force)
  }

  private async performClose(force: boolean): Promise<void> {
    const errors: unknown[] = []

    try {
      if (force) {
        for (const child of [...this.children]) {
          try {
            await child.close()
          } catch (error) {
            collectError(errors, error)
          }
        }
      }

      for (let index = this.finalizers.length - 1; index >= 0; index -= 1) {
        const finalizer = this.finalizers[index]
        if (!finalizer) {
          continue
        }
        if (finalizer.cell) {
          finalizer.cell.state = "disposing"
        }
        try {
          await this.runtime.ambient.run(this, () =>
            this.runtime.teardown.run(this, () => finalizer.run()),
          )
        } catch (error) {
          collectError(errors, error)
        } finally {
          if (finalizer.cell) {
            finalizer.cell.state = "disposed"
          }
        }
      }
    } finally {
      this.finalizers.length = 0
      this.viewCache.clear()
      this.ownedCells.clear()
      this.bindings.clear()
      this.state = "closed"
      this[scopeParent]?.childClosed(this)
    }

    if (errors.length > 0) {
      this.lifecycle.reject(
        new AggregateError(
          errors,
          `Errors while closing scope "${this.name}".`,
        ),
      )
    } else {
      this.lifecycle.resolve()
    }
  }

  private childClosed(child: ScopeContext): void {
    this.children.delete(child)
    if (this.state === "retiring" && this.children.size === 0) {
      this.beginClose(false)
    }
  }
}

/**
 * Resolves and validates the complete provision list before scope construction.
 *
 * This boundary prevents duplicate or foreign input from acquiring membership,
 * installing bindings, or registering owned-value finalizers partially.
 */
function validateProvisions(
  runtime: RuntimeContext,
  provisions: readonly Provision[],
): readonly ProvisionRecord<unknown>[] {
  const records = provisions.map(provisionOf)
  const seen = new Set<DependencyNode<unknown>>()

  for (const record of records) {
    const node = nodeOf(record.dependency)
    if (node.runtime !== runtime) {
      throw new CrossRuntimeDependencyError(
        node.name,
        node.runtime.name,
        runtime.name,
      )
    }
    if (seen.has(node)) {
      throw new DuplicateProviderError(node.name)
    }
    seen.add(node)
  }

  // Standard disposer lookup can invoke a getter and throw. Keep it inside the
  // claim boundary so a failed lookup neither creates a scope nor consumes an
  // owned provision.
  return claimOwnedProvisions(provisions, () =>
    records.map((record) => {
      if (record.spec.kind !== "owned-value" || record.spec.dispose !== true) {
        return record
      }

      const node = nodeOf(record.dependency)
      const run = cleanupOf(node.name, record.spec.value, true)
      return {
        dependency: record.dependency,
        spec: {
          kind: "owned-value" as const,
          value: record.spec.value,
          dispose: () => run(),
        },
      }
    }),
  )
}

/**
 * Executes a callback in a temporary ambient child and guarantees force cleanup.
 *
 * Callback errors, leaked children, and teardown failures are preserved together
 * when more than one condition occurs.
 */
export async function withChildScope<TCallbackResult>(
  parent: ScopeContext,
  provisions: ProvisionInput,
  callback: (scope: ScopeContext) => TCallbackResult,
): Promise<Awaited<TCallbackResult>> {
  const child = parent.createScope(provisions)
  const errors: unknown[] = []
  let callbackFailed = false
  let result!: Awaited<TCallbackResult>

  try {
    result = await child.run(() => callback(child))
  } catch (error) {
    callbackFailed = true
    errors.push(error)
  }

  if (child.children.size > 0) {
    errors.push(new LeakedChildScopeError(child.name, child.children.size))
  }

  try {
    await child.close()
  } catch (error) {
    collectError(errors, error)
  }

  if (errors.length === 1) {
    throw errors[0]
  }
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `Errors in scoped callback "${child.name}".`,
    )
  }
  if (callbackFailed) {
    throw new Error("ripple-di lost a scoped callback error.")
  }
  return result
}

/** Reproduces the current scope layers beneath a separate lifecycle parent. */
export async function withDetachedScopeContext<TCallbackResult>(
  base: ScopeContext,
  current: ScopeContext,
  callback: (scope: ScopeContext) => TCallbackResult,
): Promise<Awaited<TCallbackResult>> {
  const snapshots = snapshotDetachedLayers(base, current)
  const layers = snapshots.length > 0 ? snapshots : [[]]
  return await replayDetachedLayers(base, layers, 0, callback)
}

/** Captures immutable provider recipes without retaining scope caches. */
function snapshotDetachedLayers(
  base: ScopeContext,
  current: ScopeContext,
): readonly (readonly Provision[])[] {
  if (current.state !== "active") {
    throw new ScopeClosedError(
      "Runtime.withDetachedContext",
      current.name,
      current.id,
      current.state,
    )
  }

  const scopes: ScopeContext[] = []
  let cursor: ScopeContext | undefined = current

  while (cursor !== base) {
    if (!cursor) {
      throw new Error(
        `Scope "${current.name}" is not beneath base scope "${base.name}".`,
      )
    }
    if (cursor.state === "closing" || cursor.state === "closed") {
      throw new ScopeClosedError(
        "Runtime.withDetachedContext",
        cursor.name,
        cursor.id,
        cursor.state,
      )
    }
    scopes.push(cursor)
    cursor = cursor[scopeParent]
  }

  scopes.reverse()

  for (const scope of scopes) {
    for (const binding of scope.bindings.values()) {
      if (binding.spec.kind === "owned-value") {
        throw new DetachedContextOwnedProvisionError(
          nodeOf(binding.stamp.dependency).name,
          scope.name,
        )
      }
    }
  }

  return scopes.map((scope) =>
    [...scope.bindings.values()].map((binding) =>
      binding.spec.kind === "missing"
        ? withoutProvider(binding.stamp.dependency)
        : binding.spec.kind === "factory"
          ? provideFactory(binding.stamp.dependency, binding.spec.factory)
          : provide(binding.stamp.dependency, binding.spec.value),
    ),
  )
}

/** Enters reproduced layers from the original outermost layer inward. */
async function replayDetachedLayers<TCallbackResult>(
  parent: ScopeContext,
  layers: readonly (readonly Provision[])[],
  index: number,
  callback: (scope: ScopeContext) => TCallbackResult,
): Promise<Awaited<TCallbackResult>> {
  const provisions = layers[index]
  if (!provisions) {
    throw new Error("ripple-di lost a detached context layer.")
  }
  return await withChildScope(parent, provisions, (scope) =>
    index === layers.length - 1
      ? callback(scope)
      : replayDetachedLayers(scope, layers, index + 1, callback),
  )
}

function createDeferred(): LifecycleDeferred {
  let settle!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((resolve, rejectPromise) => {
    settle = resolve
    reject = rejectPromise
  })
  return { promise, resolve: settle, reject }
}

function collectError(errors: unknown[], error: unknown): void {
  if (error instanceof AggregateError) {
    errors.push(...error.errors)
  } else {
    errors.push(error)
  }
}
