import { AsyncLocalStorage } from "node:async_hooks"

import {
  type ComputedOptions,
  createDependency,
  type Dependency,
  nodeOf,
  type ResourceOptions,
  type SlotOptions,
} from "./dependency"
import {
  CrossRuntimeDependencyError,
  DisposerContextError,
  InstallationConflictError,
  ScopeClosedError,
} from "./errors"
import { assertOutsideEvaluation, currentEvaluation } from "./evaluation"
import type {
  BoundProvider,
  DependencyNode,
  RuntimeContext,
  ScopeContext,
} from "./graph"
import type { Provision } from "./provide"
import { resolveTracked } from "./resolution"
import { type Scope, ScopeImpl, withChildScope } from "./scope"

/** Options for starting an independent dependency graph. */
export interface RuntimeOptions {
  /** Human-readable name used in scope names and error messages. */
  readonly name?: string
}

/**
 * Long-lived providers used as the default application wiring for a Runtime.
 *
 * Close the installation to remove its providers and clean up the scopes and
 * resources created from them.
 */
export interface Installation {
  /** Removes these providers and closes everything owned beneath them. */
  close(): Promise<void>
}

/**
 * An independent dependency graph with its own definitions and resources.
 *
 * Most applications can use the module-level functions and do not need to
 * create a Runtime explicitly.
 * Installation and Scope management methods cannot be called from one of this
 * Runtime's Dependency factories or resource disposers.
 */
export interface Runtime {
  /**
   * Defines a value that can be supplied by an Installation or Scope.
   *
   * Options are needed only for a default value or a custom diagnostic name.
   */
  defineSlot<T>(options?: SlotOptions<T>): Dependency<T>
  /** Defines a value calculated lazily from other dependencies. */
  defineComputed<T>(compute: () => T, options?: ComputedOptions): Dependency<T>
  /** Defines a lazily created service with optional cleanup. */
  defineResource<T>(
    create: () => T,
    options?: ResourceOptions<T>,
  ): Dependency<T>

  /**
   * Installs long-lived providers as the fallback beneath scoped overrides.
   *
   * A Runtime can have one active installation, and previously created scopes
   * must be fully closed before this method is called.
   */
  install(provisions: readonly Provision[]): Installation
  /** Returns a dependency value from the current scope. */
  resolve<T>(dependency: Dependency<T>): T
  /** Creates a manually managed child of the current scope. */
  createScope(provisions?: readonly Provision[]): Scope
  /**
   * Runs a callback with temporary overrides and cleans up everything created
   * for the callback afterward.
   */
  withOverrides<R>(
    provisions: readonly Provision[],
    callback: (scope: Scope) => R | Promise<R>,
  ): Promise<Awaited<R>>
  /** Closes every scope and cleans up every resource owned by this runtime. */
  dispose(): Promise<void>
}

let nextRuntimeId = 1

/** Concrete owner of one independent dependency graph. */
class RuntimeImpl implements RuntimeContext {
  readonly id = nextRuntimeId++
  readonly name: string
  readonly ambient = new AsyncLocalStorage<ScopeContext>()
  readonly teardown = new AsyncLocalStorage<ScopeContext>()
  readonly root: ScopeImpl

  private readonly defaults = new Map<
    DependencyNode<unknown>,
    BoundProvider<unknown>
  >()
  private activeInstallation: InstallationImpl | undefined
  private closingInstallation: InstallationImpl | undefined

  constructor(options: RuntimeOptions = {}) {
    this.name = options.name ?? `runtime-${this.id}`
    this.root = new ScopeImpl(this, undefined, [])
  }

  defineSlot<T>(options: SlotOptions<T> = {}): Dependency<T> {
    return createDependency({
      name: options.name,
      kind: "slot",
      runtime: this,
      defaultSpec: options.default
        ? { kind: "factory", factory: options.default }
        : undefined,
      dispose: undefined,
    })
  }

  defineComputed<T>(
    compute: () => T,
    options: ComputedOptions = {},
  ): Dependency<T> {
    return createDependency({
      name: options.name,
      kind: "computed",
      runtime: this,
      defaultSpec: { kind: "factory", factory: compute },
      dispose: undefined,
    })
  }

  defineResource<T>(
    create: () => T,
    options: ResourceOptions<T> = {},
  ): Dependency<T> {
    return createDependency({
      name: options.name,
      kind: "resource",
      runtime: this,
      defaultSpec: { kind: "factory", factory: create },
      dispose: options.dispose,
    })
  }

  install(provisions: readonly Provision[]): Installation {
    this.assertScopeManagementAllowed("Runtime.install")
    if (this.root.state !== "active") {
      throw new ScopeClosedError(
        "Runtime.install",
        this.root.name,
        this.root.id,
        this.root.state,
      )
    }
    if (this.activeInstallation) {
      throw new InstallationConflictError(this.name, "active-installation")
    }
    if (this.closingInstallation) {
      throw new InstallationConflictError(this.name, "closing-installation")
    }
    if (this.root.children.size > 0) {
      throw new InstallationConflictError(
        this.name,
        "live-scopes",
        [...this.root.children].map((scope) => scope.name),
      )
    }

    const installation = new InstallationImpl(
      this,
      this.root.createScope(provisions),
    )
    this.activeInstallation = installation
    return installation
  }

  resolve<T>(dependency: Dependency<T>): T {
    const node = nodeOf(dependency)
    this.assertOwnDependency(node)
    return resolveTracked(this.currentScope(node.name), node)
  }

  createScope(provisions: readonly Provision[] = []): Scope {
    this.assertScopeManagementAllowed("Runtime.createScope")
    return this.currentAmbientScope().createScope(provisions)
  }

  withOverrides<R>(
    provisions: readonly Provision[],
    callback: (scope: Scope) => R | Promise<R>,
  ): Promise<Awaited<R>> {
    this.assertScopeManagementAllowed("Runtime.withOverrides")
    return withChildScope(this.currentAmbientScope(), provisions, callback)
  }

  dispose(): Promise<void> {
    this.assertScopeManagementAllowed("Runtime.dispose")
    this.activeInstallation = undefined
    return this.root.close()
  }

  closeInstallation(installation: InstallationImpl): Promise<void> {
    if (this.activeInstallation === installation) {
      this.activeInstallation = undefined
      this.closingInstallation = installation
      const close = installation.scope.close()
      // Return the derived chain so an ignored failed close remains an unhandled rejection.
      return close.then(
        () => {
          this.finishClosingInstallation(installation)
        },
        (error: unknown) => {
          this.finishClosingInstallation(installation)
          throw error
        },
      )
    }
    return installation.scope.close()
  }

  assertScopeManagementAllowed(operation: string): void {
    assertOutsideEvaluation(this, operation)
    const owner = this.teardown.getStore()
    if (owner) {
      throw new DisposerContextError(operation, owner.name, owner.id)
    }
  }

  readCallable<T>(node: DependencyNode<T>): T {
    const frame = currentEvaluation()
    if (frame) {
      if (frame.runtime !== this) {
        frame.hasFailedDependencyRead = true
        throw new CrossRuntimeDependencyError(
          node.name,
          this.name,
          frame.runtime.name,
        )
      }
      return resolveTracked(frame.scope, node)
    }

    return resolveTracked(this.ambient.getStore() ?? this.baseScope(), node)
  }

  getDefaultProvider<T>(node: DependencyNode<T>): BoundProvider<T> | undefined {
    if (!node.defaultSpec) {
      return undefined
    }

    const unknownNode = node as DependencyNode<unknown>
    let provider = this.defaults.get(unknownNode)
    if (!provider) {
      provider = {
        spec: node.defaultSpec,
        stamp: {
          kind: "binding",
          identity: Symbol(`${node.name}:default-binding`),
          dependency: node.dependency,
          home: this.root,
        },
      } as BoundProvider<unknown>
      this.defaults.set(unknownNode, provider)
    }
    return provider as BoundProvider<T>
  }

  private currentScope(operation: string): ScopeContext {
    const frame = currentEvaluation()
    if (frame) {
      if (frame.runtime !== this) {
        frame.hasFailedDependencyRead = true
        throw new CrossRuntimeDependencyError(
          operation,
          this.name,
          frame.runtime.name,
        )
      }
      return frame.scope
    }
    return this.ambient.getStore() ?? this.baseScope()
  }

  private currentAmbientScope(): ScopeContext {
    return this.ambient.getStore() ?? this.baseScope()
  }

  private baseScope(): ScopeImpl {
    return this.activeInstallation?.scope ?? this.root
  }

  private finishClosingInstallation(installation: InstallationImpl): void {
    if (this.closingInstallation === installation) {
      this.closingInstallation = undefined
    }
  }

  private assertOwnDependency<T>(node: DependencyNode<T>): void {
    if (node.runtime !== this) {
      throw new CrossRuntimeDependencyError(
        node.name,
        node.runtime.name,
        this.name,
      )
    }
  }
}

class InstallationImpl implements Installation {
  private closePromise: Promise<void> | undefined

  constructor(
    private readonly runtime: RuntimeImpl,
    readonly scope: ScopeImpl,
  ) {}

  close(): Promise<void> {
    this.runtime.assertScopeManagementAllowed("Installation.close")
    this.closePromise ??= this.runtime.closeInstallation(this)
    return this.closePromise
  }
}

/**
 * Creates an independent dependency graph.
 *
 * Define its dependencies through the methods on the returned Runtime.
 */
export function createRuntime(options: RuntimeOptions = {}): Runtime {
  return new RuntimeImpl(options)
}

const globalRuntime = new RuntimeImpl({ name: "global" })

/**
 * Defines an input supplied by an Installation or Scope, or by a default
 * factory.
 */
export function defineSlot<T>(options: SlotOptions<T> = {}): Dependency<T> {
  return globalRuntime.defineSlot(options)
}

/** Defines a lazily calculated value. */
export function defineComputed<T>(
  compute: () => T,
  options: ComputedOptions = {},
): Dependency<T> {
  return globalRuntime.defineComputed(compute, options)
}

/**
 * Defines a lazily created service with optional cleanup.
 *
 * The service is recreated when one of its tracked dependencies is overridden.
 */
export function defineResource<T>(
  create: () => T,
  options: ResourceOptions<T> = {},
): Dependency<T> {
  return globalRuntime.defineResource(create, options)
}

/**
 * Installs long-lived providers for module-level Dependencies.
 *
 * Scoped overrides still take priority. Close the returned installation to
 * remove its providers and clean up everything created from them.
 */
export function install(provisions: readonly Provision[]): Installation {
  return globalRuntime.install(provisions)
}

/** Returns a dependency value from the current scope. */
export function resolve<T>(dependency: Dependency<T>): T {
  return globalRuntime.resolve(dependency)
}

/** Creates a manually managed scope with optional dependency overrides. */
export function createScope(provisions: readonly Provision[] = []): Scope {
  return globalRuntime.createScope(provisions)
}

/**
 * Runs a callback with temporary dependency overrides.
 *
 * Overrides remain active across `await`, stay isolated from concurrent
 * callbacks, and are cleaned up when the callback finishes.
 */
export function withOverrides<R>(
  provisions: readonly Provision[],
  callback: (scope: Scope) => R | Promise<R>,
): Promise<Awaited<R>> {
  return globalRuntime.withOverrides(provisions, callback)
}

/** Cleans up every resource and scope created through module-level functions. */
export function dispose(): Promise<void> {
  return globalRuntime.dispose()
}
