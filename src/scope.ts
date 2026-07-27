import { type Dependency, nodeOf } from "./dependency"
import {
  CrossRuntimeDependencyError,
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
  type ProvisionRecord,
  provisionOf,
} from "./provide"
import { resolveTracked } from "./resolution"

/** Current lifecycle phase of a scope. */
export type ScopeState = "active" | "retiring" | "closing" | "closed"

/**
 * An isolated view of dependency values that inherits from a parent scope.
 *
 * A scope can replace selected dependencies without changing its parent.
 * Scope management and lifecycle methods cannot be called from a Dependency
 * factory or resource disposer in the same Runtime.
 */
export interface Scope {
  /** Returns a dependency value explicitly from this scope. */
  resolve<T>(dependency: Dependency<T>): T
  /** Creates a child scope with optional dependency overrides. */
  createScope(provisions?: readonly Provision[]): Scope
  /** Makes this scope current while the callback runs without closing it. */
  run<R>(callback: () => R): R
  /** Runs a callback in a temporary child scope and cleans it up afterward. */
  withOverrides<R>(
    provisions: readonly Provision[],
    callback: (scope: Scope) => R | Promise<R>,
  ): Promise<Awaited<R>>
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
 * Immutable binding overlay and physical owner of locally published Cells.
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

  resolve<T>(dependency: Dependency<T>): T {
    const node = nodeOf(dependency)
    return resolveTracked(this, node)
  }

  createScope(provisions: readonly Provision[] = []): ScopeImpl {
    this.runtime.assertScopeManagementAllowed("Scope.createScope")
    this.assertActive("<createScope>")
    const records = validateProvisions(this.runtime, provisions)
    return new ScopeImpl(this.runtime, this, records)
  }

  run<R>(callback: () => R): R {
    this.runtime.assertScopeManagementAllowed("Scope.run")
    this.assertActive("<run>")
    return this.runtime.ambient.run(this, callback)
  }

  withOverrides<R>(
    provisions: readonly Provision[],
    callback: (scope: Scope) => R | Promise<R>,
  ): Promise<Awaited<R>> {
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

  publish<T>(cell: Cell<T>, requestedScope: ScopeContext): void {
    if (this.state !== "active" && this.state !== "retiring") {
      throw new ScopeClosedError(cell.node.name, this.name, this.id, this.state)
    }

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

    if (cell.node.dispose) {
      const dispose = cell.node.dispose
      this.finalizers.push({
        cell: cell as Cell<unknown>,
        run: () => dispose(cell.value),
      })
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
        run: () => dispose(value),
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
 * Resolves and validates the complete provision list before Scope construction.
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
  claimOwnedProvisions(provisions)
  return records
}

/**
 * Executes a callback in a temporary ambient child and guarantees force cleanup.
 *
 * Callback errors, leaked children, and teardown failures are preserved together
 * when more than one condition occurs.
 */
export async function withChildScope<R>(
  parent: ScopeContext,
  provisions: readonly Provision[],
  callback: (scope: Scope) => R | Promise<R>,
): Promise<Awaited<R>> {
  const child = parent.createScope(provisions)
  const errors: unknown[] = []
  let callbackFailed = false
  let result!: Awaited<R>

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
