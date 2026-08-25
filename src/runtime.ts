import { AsyncLocalStorage } from "node:async_hooks"

import {
  captureDefinitionSite,
  createDependency,
  type Dependency,
  type DependencyOptions,
  nodeOf,
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
import {
  createOverrideRunnerFor,
  createValueOverrideFor,
  type OverrideRunner,
  type ProvisionFactory,
  type ValueOverride,
} from "./overrides"
import type { ProvideOptions, ProvisionInput } from "./provide"
import { resolveTracked } from "./resolution"
import { type Scope, ScopeImpl, withChildScope } from "./scope"
import type { FactoryResult } from "./value"

/** Options for starting an independent dependency graph. */
export interface RuntimeOptions {
  /** Human-readable name used in scope names and error messages. */
  readonly name?: string
}

/**
 * Long-lived providers used as the default application wiring for a runtime.
 *
 * Close the installation to remove its providers and clean up the scopes and
 * owned values created beneath it.
 */
export interface Installation {
  /** Removes these providers and closes everything owned beneath them. */
  close(): Promise<void>
}

/**
 * An independent dependency graph with its own definitions, cached values,
 * and lifecycle.
 *
 * Most applications can use the module-level functions and do not need to
 * create a runtime explicitly.
 * Installation and scope management methods cannot be called from one of this
 * runtime's dependency factories or disposers.
 */
export interface Runtime {
  /**
   * Defines a dependency with no built-in value.
   *
   * Supply it through an installation or scope before reading it.
   * A configured disposer applies only to values Ripple DI owns.
   */
  defineDependency<T>(options?: DependencyOptions<T>): Dependency<T>
  /**
   * Defines a dependency with a lazy built-in factory.
   *
   * The result is cached. A scope gets a separate result when it overrides a
   * dependency that the factory called.
   */
  defineDependency<T>(
    factory: () => FactoryResult<T>,
    options?: DependencyOptions<T>,
  ): Dependency<T>

  /**
   * Installs long-lived providers as the fallback beneath scoped overrides.
   *
   * A runtime can have one active installation, and previously created scopes
   * must be fully closed before this method is called.
   */
  install(provisions: ProvisionInput): Installation
  /** Returns a dependency value from the current scope. */
  resolve<T>(dependency: Dependency<T>): T
  /** Creates a manually managed child of the current scope. */
  createScope(provisions?: ProvisionInput): Scope
  /**
   * Runs a callback with temporary overrides and cleans up everything created
   * for the callback afterward.
   */
  withOverrides<TCallbackResult>(
    provisions: ProvisionInput,
    callback: (scope: Scope) => TCallbackResult,
  ): Promise<Awaited<TCallbackResult>>
  /**
   * Prepares overrides that are applied again to each call of the returned
   * runner.
   */
  createOverrideRunner(factory: ProvisionFactory): OverrideRunner
  /**
   * Prepares a reusable helper that replaces one dependency with a value for
   * one callback.
   */
  createValueOverride<T>(
    dependency: Dependency<T>,
    options?: ProvideOptions<NoInfer<T>>,
  ): ValueOverride<T>
  /** Closes every scope and cleans up every value owned by this runtime. */
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

  // Keep the options overload first so invalid values get the useful
  // "not assignable to () => T" diagnostic from TypeScript.
  defineDependency<T>(options?: DependencyOptions<T>): Dependency<T>
  defineDependency<T>(
    factory: () => FactoryResult<T>,
    options?: DependencyOptions<T>,
  ): Dependency<T>
  defineDependency<T>(
    factoryOrOptions?: (() => FactoryResult<T>) | DependencyOptions<T>,
    maybeOptions?: DependencyOptions<T>,
  ): Dependency<T> {
    return this.defineDependencyAt(
      factoryOrOptions,
      maybeOptions,
      captureDefinitionSite(this.defineDependency),
    )
  }

  defineDependencyAt<T>(
    factoryOrOptions:
      | (() => FactoryResult<T>)
      | DependencyOptions<T>
      | undefined,
    maybeOptions: DependencyOptions<T> | undefined,
    definitionSite: string | undefined,
  ): Dependency<T> {
    const isFactory = typeof factoryOrOptions === "function"
    const factory = isFactory ? factoryOrOptions : undefined
    const options: DependencyOptions<T> =
      (isFactory ? maybeOptions : factoryOrOptions) ?? {}

    return createDependency({
      name: options.name ?? (factory?.name || undefined),
      definitionSite,
      runtime: this,
      defaultFactory: factory,
      dispose: options.dispose,
    })
  }

  install(provisions: ProvisionInput): Installation {
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

  createScope(provisions: ProvisionInput = []): Scope {
    this.assertScopeManagementAllowed("Runtime.createScope")
    return this.currentAmbientScope().createScope(provisions)
  }

  withOverrides<TCallbackResult>(
    provisions: ProvisionInput,
    callback: (scope: Scope) => TCallbackResult,
  ): Promise<Awaited<TCallbackResult>> {
    this.assertScopeManagementAllowed("Runtime.withOverrides")
    return withChildScope(this.currentAmbientScope(), provisions, callback)
  }

  createOverrideRunner(factory: ProvisionFactory): OverrideRunner {
    return createOverrideRunnerFor(this, factory)
  }

  createValueOverride<T>(
    dependency: Dependency<T>,
    options: ProvideOptions<NoInfer<T>> = {},
  ): ValueOverride<T> {
    this.assertOwnDependency(nodeOf(dependency))
    return createValueOverrideFor(this, dependency, options)
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

  currentAmbientScope(): ScopeContext {
    return this.ambient.getStore() ?? this.baseScope()
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
    if (!node.defaultFactory) {
      return undefined
    }

    const unknownNode = node as DependencyNode<unknown>
    let provider = this.defaults.get(unknownNode)
    if (!provider) {
      provider = {
        spec: { kind: "factory", factory: node.defaultFactory },
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
 * Define its dependencies through the methods on the returned runtime.
 */
export function createRuntime(options: RuntimeOptions = {}): Runtime {
  return new RuntimeImpl(options)
}

const globalRuntime = new RuntimeImpl({ name: "global" })

/**
 * Defines a dependency with no built-in value.
 *
 * Supply it through an installation or scope before reading it.
 * A configured disposer applies only to values Ripple DI owns.
 */
export function defineDependency<T>(
  options?: DependencyOptions<T>,
): Dependency<T>
/**
 * Defines a dependency with a lazy built-in factory.
 *
 * The result is cached. A scope gets a separate result when it overrides a
 * dependency that the factory called.
 */
export function defineDependency<T>(
  factory: () => FactoryResult<T>,
  options?: DependencyOptions<T>,
): Dependency<T>
export function defineDependency<T>(
  factoryOrOptions?: (() => FactoryResult<T>) | DependencyOptions<T>,
  maybeOptions?: DependencyOptions<T>,
): Dependency<T> {
  return globalRuntime.defineDependencyAt(
    factoryOrOptions,
    maybeOptions,
    captureDefinitionSite(defineDependency),
  )
}

/**
 * Installs long-lived providers for module-level dependencies.
 *
 * Scoped overrides still take priority. Close the returned installation to
 * remove its providers and clean up everything created from them.
 */
export function install(provisions: ProvisionInput): Installation {
  return globalRuntime.install(provisions)
}

/** Returns a dependency value from the current scope. */
export function resolve<T>(dependency: Dependency<T>): T {
  return globalRuntime.resolve(dependency)
}

/** Creates a manually managed scope with optional dependency overrides. */
export function createScope(provisions: ProvisionInput = []): Scope {
  return globalRuntime.createScope(provisions)
}

/**
 * Runs a callback with temporary dependency overrides.
 *
 * Overrides remain active across `await`, stay isolated from concurrent
 * callbacks, and are cleaned up when the callback finishes.
 */
export function withOverrides<TCallbackResult>(
  provisions: ProvisionInput,
  callback: (scope: Scope) => TCallbackResult,
): Promise<Awaited<TCallbackResult>> {
  return globalRuntime.withOverrides(provisions, callback)
}

/**
 * Prepares dependency overrides that are applied again to each call of the
 * returned runner.
 *
 * The factory runs again for every call, so a call can own the values it
 * provides.
 */
export function createOverrideRunner(
  factory: ProvisionFactory,
): OverrideRunner {
  return globalRuntime.createOverrideRunner(factory)
}

/**
 * Prepares a helper that replaces one dependency with a value for one callback.
 *
 * Use it for a dependency that application code supplies the same way in many
 * places, such as a client or a request context.
 * Ownership options given here apply to every value the helper receives.
 */
export function createValueOverride<T>(
  dependency: Dependency<T>,
  options?: ProvideOptions<NoInfer<T>>,
): ValueOverride<T> {
  return globalRuntime.createValueOverride(dependency, options)
}

/** Closes every scope and cleans up every owned value. */
export function dispose(): Promise<void> {
  return globalRuntime.dispose()
}
