import type { AsyncLocalStorage } from "node:async_hooks"

import type { DependencyToken, Disposer } from "./dependency"
import type { ProvisionInput } from "./provide"
import type { Runtime } from "./runtime"
import type { Scope, ScopeState } from "./scope"
import type { FactoryResult } from "./value"

/** Internal key for traversing scope ancestry without exposing parent handles. */
export const scopeParent = Symbol("scope-parent")

/** Pure provider recipe that has not yet been installed in a scope. */
export type ProviderSpec<T> =
  | {
      readonly kind: "missing"
    }
  | {
      readonly kind: "value"
      readonly value: T
    }
  | {
      readonly kind: "owned-value"
      readonly value: T
      readonly dispose: Disposer<T> | true
    }
  | {
      readonly kind: "factory"
      readonly factory: () => FactoryResult<T>
    }

/** Internal runtime surface shared by resolution and lifecycle modules. */
export interface RuntimeContext extends Runtime {
  readonly id: number
  readonly name: string
  readonly ambient: AsyncLocalStorage<ScopeContext>
  readonly teardown: AsyncLocalStorage<ScopeContext>
  readonly root: ScopeContext

  assertScopeManagementAllowed(operation: string): void
  currentAmbientScope(): ScopeContext
  readCallable<T>(node: DependencyNode<T>): T
  getDefaultProvider<T>(node: DependencyNode<T>): BoundProvider<T> | undefined
}

/** Private metadata associated with one property-free callable dependency. */
export interface DependencyNode<T> {
  readonly id: number
  readonly name: string
  readonly runtime: RuntimeContext
  readonly dependency: DependencyToken<T>
  readonly defaultFactory: (() => FactoryResult<T>) | undefined
  readonly dispose: Disposer<T> | true | undefined
}

/** Identity of one provider installation, including a runtime-specific default. */
export interface BindingStamp<T = unknown> {
  readonly kind: "binding"
  readonly identity: symbol
  readonly dependency: DependencyToken<T>
  readonly home: ScopeContext
}

/** Identity of one successfully materialized factory value. */
export interface CellStamp<T = unknown> {
  readonly kind: "cell"
  readonly identity: symbol
  readonly dependency: DependencyToken<T>
  readonly home: ScopeContext
}

export type DependencyStamp<T = unknown> = BindingStamp<T> | CellStamp<T>

export interface BoundProvider<T> {
  readonly spec: ProviderSpec<T>
  readonly stamp: BindingStamp<T>
}

/** Value plus the binding or cell identity observed by a resolution. */
export interface ResolutionRef<T> {
  readonly value: T
  readonly stamp: DependencyStamp<T>
}

/** One effective dependency identity retained by a factory cell. */
export interface DependencyRecord {
  readonly dependency: DependencyToken<unknown>
  readonly stamp: DependencyStamp
}

/** Tracked identity retained without keeping its originating scope alive. */
export interface DependencyIdentityRecord {
  readonly dependency: DependencyToken<unknown>
  readonly identity: symbol
}

/**
 * Memoized factory result physically owned and disposed by exactly one scope.
 *
 * Borrowing scopes only cache a reference to this cell and never register its
 * finalizer.
 */
export interface Cell<T> extends ResolutionRef<T> {
  readonly dependency: DependencyToken<T>
  readonly node: DependencyNode<T>
  readonly owner: ScopeContext
  readonly stamp: CellStamp<T>
  readonly providerStamp: BindingStamp<T>
  readonly dependencies: readonly DependencyRecord[]
  readonly reusable: boolean
  state: "ready" | "disposing" | "disposed"
}

/** Acquisition-ordered cleanup entry owned by one scope. */
export interface Finalizer {
  readonly cell?: Cell<unknown>
  readonly run: () => void | Promise<void>
}

/** Internal mutable scope state required by resolution and teardown. */
export interface ScopeContext extends Scope {
  readonly id: number
  readonly name: string
  readonly runtime: RuntimeContext
  readonly [scopeParent]: ScopeContext | undefined
  readonly depth: number
  readonly bindings: Map<DependencyNode<unknown>, BoundProvider<unknown>>
  readonly viewCache: Map<DependencyNode<unknown>, ResolutionRef<unknown>>
  readonly ownedCells: Map<DependencyNode<unknown>, Cell<unknown>>
  readonly finalizers: Finalizer[]
  readonly children: Set<ScopeContext>
  state: ScopeState

  createScope(provisions?: ProvisionInput): ScopeContext
  publish<T>(cell: Cell<T>, requestedScope: ScopeContext): void
}
