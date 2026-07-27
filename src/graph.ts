import type { AsyncLocalStorage } from "node:async_hooks"

import type { Dependency, Disposer } from "./dependency"
import type { Provision } from "./provide"
import type { Runtime } from "./runtime"
import type { Scope, ScopeState } from "./scope"

export type DependencyKind = "slot" | "computed" | "resource"

/** Pure provider recipe that has not yet been installed in a Scope. */
export type ProviderSpec<T> =
  | {
      readonly kind: "value"
      readonly value: T
    }
  | {
      readonly kind: "owned-value"
      readonly value: T
      readonly dispose: Disposer<T>
    }
  | {
      readonly kind: "factory"
      readonly factory: () => T
    }

/** Internal Runtime surface shared by resolution and lifecycle modules. */
export interface RuntimeContext extends Runtime {
  readonly id: number
  readonly name: string
  readonly ambient: AsyncLocalStorage<ScopeContext>
  readonly teardown: AsyncLocalStorage<ScopeContext>
  readonly root: ScopeContext

  assertScopeManagementAllowed(operation: string): void
  readCallable<T>(node: DependencyNode<T>): T
  getDefaultProvider<T>(node: DependencyNode<T>): BoundProvider<T> | undefined
}

/** Private metadata associated with one property-free callable Dependency. */
export interface DependencyNode<T> {
  readonly id: number
  readonly name: string
  readonly kind: DependencyKind
  readonly runtime: RuntimeContext
  readonly dependency: Dependency<T>
  readonly defaultSpec: ProviderSpec<T> | undefined
  readonly dispose: Disposer<T> | undefined
}

/** Identity of one provider installation, including a runtime-specific default. */
export interface BindingStamp<T = unknown> {
  readonly kind: "binding"
  readonly identity: symbol
  readonly dependency: Dependency<T>
  readonly home: ScopeContext
}

/** Identity of one successfully materialized computed value or resource. */
export interface CellStamp<T = unknown> {
  readonly kind: "cell"
  readonly identity: symbol
  readonly dependency: Dependency<T>
  readonly home: ScopeContext
}

export type DependencyStamp<T = unknown> = BindingStamp<T> | CellStamp<T>

export interface BoundProvider<T> {
  readonly spec: ProviderSpec<T>
  readonly stamp: BindingStamp<T>
}

/** Value plus the binding or Cell identity observed by a resolution. */
export interface ResolutionRef<T> {
  readonly value: T
  readonly stamp: DependencyStamp<T>
}

/** One actual direct callable read recorded during factory evaluation. */
export interface DependencyRecord {
  readonly dependency: Dependency<unknown>
  readonly stamp: DependencyStamp
}

/**
 * Memoized factory result physically owned and disposed by exactly one Scope.
 *
 * Borrowing Scopes only cache a reference to this Cell and never register its
 * finalizer.
 */
export interface Cell<T> extends ResolutionRef<T> {
  readonly dependency: Dependency<T>
  readonly node: DependencyNode<T>
  readonly owner: ScopeContext
  readonly stamp: CellStamp<T>
  readonly providerStamp: BindingStamp<T>
  readonly dependencies: readonly DependencyRecord[]
  readonly reusable: boolean
  state: "ready" | "disposing" | "disposed"
}

/** Acquisition-ordered cleanup entry owned by one Scope. */
export interface Finalizer {
  readonly cell?: Cell<unknown>
  readonly run: () => void | Promise<void>
}

/** Internal mutable Scope state required by resolution and teardown. */
export interface ScopeContext extends Scope {
  readonly id: number
  readonly name: string
  readonly runtime: RuntimeContext
  readonly parent: ScopeContext | undefined
  readonly depth: number
  readonly bindings: Map<DependencyNode<unknown>, BoundProvider<unknown>>
  readonly viewCache: Map<DependencyNode<unknown>, ResolutionRef<unknown>>
  readonly ownedCells: Map<DependencyNode<unknown>, Cell<unknown>>
  readonly finalizers: Finalizer[]
  readonly children: Set<ScopeContext>
  state: ScopeState

  createScope(provisions?: readonly Provision[]): ScopeContext
  publish<T>(cell: Cell<T>, requestedScope: ScopeContext): void
}
