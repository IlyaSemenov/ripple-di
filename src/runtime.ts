import { AsyncLocalStorage } from "node:async_hooks"
import { isGeneratorObject } from "node:util/types"

import {
  type AnyFactory,
  captureDefinitionSite,
  createDependency,
  createFactoryDependency,
  type Dependency,
  type DependencyOptions,
  type DependencyToken,
  type FactoryDependency,
  type FactoryDependencyOptions,
  nodeOf,
} from "./dependency"
import {
  createDetachedScopeStream,
  type DetachedStream,
  type DetachedStreamOptions,
  runDetachedScopeContext,
} from "./detached"
import {
  CrossRuntimeDependencyError,
  DisposerContextError,
  InstallationConflictError,
  ScopeClosedError,
} from "./errors"
import { assertOutsideTracking, currentEvaluation, currentTracking } from "./evaluation"
import type { BoundProvider, DependencyNode, RuntimeContext, ScopeContext } from "./graph"
import {
  createOverrideRunnerFor,
  createValueOverrideFor,
  type OverrideRunner,
  type ProvisionFactory,
  type ValueOverride,
} from "./overrides"
import {
  collectProvisions,
  type ProvideOptions,
  type ProvisionCollectionInput,
  type ProvisionInput,
} from "./provide"
import { resolveTracked } from "./resolution"
import { type Scope, ScopeImpl, withChildScope } from "./scope"
import type { FactoryResult } from "./value"

/** Options for `createRuntime`. */
export interface RuntimeOptions {
  /** Name shown in error messages. */
  readonly name?: string
}

/**
 * The application's values supplied with `install`.
 *
 * Close it before installing a replacement.
 */
export interface Installation extends AsyncDisposable {
  /**
   * Closes the scopes created beneath the installation, removes the installed
   * values, and cleans up the values that the installation and those scopes
   * own.
   */
  close(): Promise<void>
}

/**
 * An independent dependency graph with its own dependencies, cached values,
 * and shutdown.
 *
 * Most applications use the module-level functions, which work with one
 * built-in runtime, and never create a runtime of their own.
 */
export interface Runtime extends AsyncDisposable {
  /**
   * Defines a dependency whose value is provided at an application, request,
   * or task boundary.
   *
   * Provide it with `install` or `withOverrides` before calling it.
   */
  defineDependency<T>(options?: DependencyOptions<T>): Dependency<T>

  /**
   * Defines a dependency whose value a factory builds on first use.
   *
   * The value is cached, and a scope that overrides a dependency the factory
   * called gets a value of its own.
   */
  defineDependency<T>(
    factory: () => FactoryResult<T>,
    options?: DependencyOptions<T>,
  ): Dependency<T>

  /**
   * Defines a replaceable function that application code calls with runtime
   * arguments.
   *
   * Each call invokes the function selected for the current scope, whose
   * results are neither cached nor cleaned up.
   */
  defineFactoryDependency<TFactory extends AnyFactory>(
    factory: TFactory,
    options?: FactoryDependencyOptions,
  ): FactoryDependency<TFactory>

  /**
   * Defines a replaceable function with no built-in implementation.
   *
   * Provide it with `install` or `withOverrides` before calling it.
   */
  defineFactoryDependency<TFactory extends AnyFactory>(
    options?: FactoryDependencyOptions,
  ): FactoryDependency<TFactory>

  /**
   * Supplies the application's values for the whole runtime.
   *
   * Installed values apply wherever no scope overrides them.
   * Install once during startup, before creating any scope, and close the
   * returned installation before installing a replacement.
   */
  install(...provisions: ProvisionCollectionInput[]): Installation

  /** Returns the value of a dependency in the current scope. */
  resolve<T>(dependency: DependencyToken<T>): T

  /**
   * Creates a scope with the given overrides beneath the current one.
   *
   * Close it when the work that shares it ends.
   */
  createScope(provisions?: ProvisionInput): Scope

  /**
   * Runs a callback with temporary overrides.
   *
   * The overrides stay active across `await` and isolated from concurrent
   * callbacks.
   * The callback's result is awaited, and then the values created for the
   * callback are cleaned up.
   */
  withOverrides<TCallbackResult>(
    provisions: ProvisionInput,
    callback: (scope: Scope) => TCallbackResult,
  ): Promise<Awaited<TCallbackResult>>

  /**
   * Runs a callback that keeps the current overrides after the current scope
   * closes.
   *
   * The overrides are applied again in new scopes, which are cleaned up after
   * the callback finishes.
   * Values handed over with `dispose` cannot be carried over.
   * Open an async generator with `createDetachedStream` instead.
   */
  runDetached<TCallbackResult>(
    callback: (scope: Scope) => TCallbackResult,
  ): Promise<Awaited<TCallbackResult>>

  /**
   * Opens an async source that keeps the current overrides for every read,
   * even after the current scope closes.
   *
   * `open` runs immediately, and its scopes close when the source finishes, a
   * read fails, the reader leaves, or `options.signal` aborts.
   * Pass the signal given to `open` to the operations inside the source so that
   * they stop promptly when the stream closes.
   * After that signal aborts, an error that is its `reason` or is named
   * `AbortError` ends the stream normally.
   * After external cancellation, await `return()` or `Symbol.asyncDispose` to
   * wait for cleanup and see its errors.
   */
  createDetachedStream<T>(
    open: (scope: Scope, signal: AbortSignal) => AsyncIterable<T>,
    options?: DetachedStreamOptions,
  ): DetachedStream<T>

  /**
   * Creates a runner that applies the same overrides to each call in a scope
   * of its own.
   *
   * `factory` runs again for every call, so each call can hand over values of
   * its own.
   */
  createOverrideRunner(factory: ProvisionFactory): OverrideRunner

  /**
   * Creates a helper that provides a value for one dependency during a
   * callback.
   *
   * Use it for a replacement repeated in several places.
   * Ownership options given here apply to every value the helper receives.
   */
  createValueOverride<T>(
    dependency: DependencyToken<T>,
    options?: ProvideOptions<NoInfer<T>>,
  ): ValueOverride<T>

  /**
   * Closes the installation and every scope, and cleans up every value the
   * runtime still owns.
   *
   * The runtime cannot be used afterward.
   */
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

  private readonly defaults = new Map<DependencyNode<unknown>, BoundProvider<unknown>>()
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

  /**
   * Defines a dependency with a definition site captured by the caller.
   *
   * The module-level function delegates here so that the captured site is the
   * application's own call and not the delegating wrapper.
   */
  defineDependencyAt<T>(
    factoryOrOptions: (() => FactoryResult<T>) | DependencyOptions<T> | undefined,
    maybeOptions: DependencyOptions<T> | undefined,
    definitionSite: string | undefined,
  ): Dependency<T> {
    const isFactory = typeof factoryOrOptions === "function"
    const factory = isFactory ? factoryOrOptions : undefined
    const options: DependencyOptions<T> = (isFactory ? maybeOptions : factoryOrOptions) ?? {}

    return createDependency({
      name: options.name ?? (factory?.name || undefined),
      definitionSite,
      runtime: this,
      defaultFactory: factory,
      dispose: options.dispose,
    })
  }

  defineFactoryDependency<TFactory extends AnyFactory>(
    factory: TFactory,
    options?: FactoryDependencyOptions,
  ): FactoryDependency<TFactory>
  defineFactoryDependency<TFactory extends AnyFactory>(
    options?: FactoryDependencyOptions,
  ): FactoryDependency<TFactory>
  defineFactoryDependency<TFactory extends AnyFactory>(
    factoryOrOptions?: TFactory | FactoryDependencyOptions,
    maybeOptions?: FactoryDependencyOptions,
  ): FactoryDependency<TFactory> {
    return this.defineFactoryDependencyAt(
      factoryOrOptions,
      maybeOptions,
      captureDefinitionSite(this.defineFactoryDependency),
    )
  }

  /** Counterpart of `defineDependencyAt` for overrideable factories. */
  defineFactoryDependencyAt<TFactory extends AnyFactory>(
    factoryOrOptions: TFactory | FactoryDependencyOptions | undefined,
    maybeOptions: FactoryDependencyOptions | undefined,
    definitionSite: string | undefined,
  ): FactoryDependency<TFactory> {
    const isFactory = typeof factoryOrOptions === "function"
    const factory = isFactory ? (factoryOrOptions as TFactory) : undefined
    const options = (isFactory ? maybeOptions : factoryOrOptions) ?? {}

    return createFactoryDependency<TFactory>({
      name: options.name ?? (factory?.name || undefined),
      definitionSite,
      runtime: this,
      defaultFactory: factory ? () => factory : undefined,
      dispose: undefined,
    })
  }

  install(...provisions: ProvisionCollectionInput[]): Installation {
    this.assertScopeManagementAllowed("Runtime.install")
    if (this.root.state !== "active") {
      throw new ScopeClosedError("Runtime.install", this.root.name, this.root.id, this.root.state)
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
        [...this.root.children].map(scope => scope.name),
      )
    }

    const installation = new InstallationImpl(
      this,
      this.root.createScope(collectProvisions(...provisions)),
    )
    this.activeInstallation = installation
    return installation
  }

  resolve<T>(dependency: DependencyToken<T>): T {
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

  runDetached<TCallbackResult>(
    callback: (scope: Scope) => TCallbackResult,
  ): Promise<Awaited<TCallbackResult>> {
    this.assertScopeManagementAllowed("Runtime.runDetached")
    return runDetachedScopeContext(this.baseScope(), this.currentAmbientScope(), async scope => {
      const result = await callback(scope)
      if (isGeneratorObject(result)) {
        throw new TypeError(
          "runDetached callback returned a generator, which would " +
            "run after the detached context closes. Open the source with " +
            "createDetachedStream instead.",
        )
      }
      return result
    })
  }

  createDetachedStream<T>(
    open: (scope: Scope, signal: AbortSignal) => AsyncIterable<T>,
    options?: DetachedStreamOptions,
  ): DetachedStream<T> {
    this.assertScopeManagementAllowed("Runtime.createDetachedStream")
    return createDetachedScopeStream(this.baseScope(), this.currentAmbientScope(), open, options)
  }

  createOverrideRunner(factory: ProvisionFactory): OverrideRunner {
    return createOverrideRunnerFor(this, factory)
  }

  createValueOverride<T>(
    dependency: DependencyToken<T>,
    options: ProvideOptions<NoInfer<T>> = {},
  ): ValueOverride<T> {
    this.assertOwnDependency(nodeOf(dependency))
    return createValueOverrideFor(this, dependency, options)
  }

  dispose(): Promise<void> {
    this.assertScopeManagementAllowed("Runtime.dispose")
    // Detach first: the installation scope then closes as an ordinary child.
    this.activeInstallation = undefined
    return this.root.close()
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose()
  }

  closeInstallation(installation: InstallationImpl): Promise<void> {
    if (this.activeInstallation === installation) {
      this.activeInstallation = undefined
      // Kept until the close settles so that a replacement install() reports
      // pending cleanup instead of unrelated live scopes.
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
    assertOutsideTracking(this, operation)
    const owner = this.teardown.getStore()
    if (owner) {
      throw new DisposerContextError(operation, owner.name, owner.id)
    }
  }

  currentAmbientScope(): ScopeContext {
    return this.ambient.getStore() ?? this.baseScope()
  }

  /**
   * Resolves a callable read from the innermost context available.
   *
   * A tracking frame pins the scope so that every read of one computation
   * agrees; otherwise the ambient scope applies, and finally the active
   * installation or the root.
   */
  readCallable<T>(node: DependencyNode<T>): T {
    const frame = currentTracking()
    if (frame) {
      if (frame.runtime && frame.runtime !== this) {
        frame.hasFailedDependencyRead = true
        throw new CrossRuntimeDependencyError(node.name, this.name, frame.runtime.name)
      }
      return resolveTracked(frame.scope ?? this.ambient.getStore() ?? this.baseScope(), node)
    }

    return resolveTracked(this.ambient.getStore() ?? this.baseScope(), node)
  }

  getDefaultProvider<T>(node: DependencyNode<T>): BoundProvider<T> | undefined {
    if (!node.defaultFactory) {
      return undefined
    }

    // Share one default binding identity across scopes so it does not prevent
    // reuse when the factory's recorded dependencies also match.
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

  /** Selects the scope for an explicit `resolve`; a factory pins it to its own. */
  private currentScope(operation: string): ScopeContext {
    const frame = currentEvaluation()
    if (frame) {
      if (frame.runtime !== this) {
        frame.hasFailedDependencyRead = true
        throw new CrossRuntimeDependencyError(operation, this.name, frame.runtime.name)
      }
      return frame.scope
    }
    return this.ambient.getStore() ?? this.baseScope()
  }

  /** Default parent for new context: the active installation, or the root. */
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
      throw new CrossRuntimeDependencyError(node.name, node.runtime.name, this.name)
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

  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
  }
}

/**
 * Creates an independent dependency graph.
 *
 * Define its dependencies through the methods of the returned runtime.
 */
export function createRuntime(options: RuntimeOptions = {}): Runtime {
  return new RuntimeImpl(options)
}

const globalRuntime = new RuntimeImpl({ name: "global" })

/**
 * Defines a dependency whose value is provided at an application, request,
 * or task boundary.
 *
 * Provide it with `install` or `withOverrides` before calling it.
 */
export function defineDependency<T>(options?: DependencyOptions<T>): Dependency<T>
/**
 * Defines a dependency whose value a factory builds on first use.
 *
 * The value is cached, and a scope that overrides a dependency the factory
 * called gets a value of its own.
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
 * Defines a replaceable function that application code calls with runtime
 * arguments.
 *
 * Each call invokes the function selected for the current scope, whose
 * results are neither cached nor cleaned up.
 */
export function defineFactoryDependency<TFactory extends AnyFactory>(
  factory: TFactory,
  options?: FactoryDependencyOptions,
): FactoryDependency<TFactory>
/**
 * Defines a replaceable function with no built-in implementation.
 *
 * Provide it with `install` or `withOverrides` before calling it.
 */
export function defineFactoryDependency<TFactory extends AnyFactory>(
  options?: FactoryDependencyOptions,
): FactoryDependency<TFactory>
export function defineFactoryDependency<TFactory extends AnyFactory>(
  factoryOrOptions?: TFactory | FactoryDependencyOptions,
  maybeOptions?: FactoryDependencyOptions,
): FactoryDependency<TFactory> {
  return globalRuntime.defineFactoryDependencyAt(
    factoryOrOptions,
    maybeOptions,
    captureDefinitionSite(defineFactoryDependency),
  )
}

/**
 * Supplies the application's values for the whole runtime.
 *
 * Installed values apply wherever no scope overrides them.
 * Install once during startup, before creating any scope, and close the
 * returned installation before installing a replacement.
 */
export function install(...provisions: ProvisionCollectionInput[]): Installation {
  return globalRuntime.install(...provisions)
}

/** Returns the value of a dependency in the current scope. */
export function resolve<T>(dependency: DependencyToken<T>): T {
  return globalRuntime.resolve(dependency)
}

/**
 * Creates a scope with the given overrides beneath the current one.
 *
 * Close it when the work that shares it ends.
 */
export function createScope(provisions: ProvisionInput = []): Scope {
  return globalRuntime.createScope(provisions)
}

/**
 * Runs a callback with temporary overrides.
 *
 * The overrides stay active across `await` and isolated from concurrent
 * callbacks.
 * The callback's result is awaited, and then the values created for the
 * callback are cleaned up.
 */
export function withOverrides<TCallbackResult>(
  provisions: ProvisionInput,
  callback: (scope: Scope) => TCallbackResult,
): Promise<Awaited<TCallbackResult>> {
  return globalRuntime.withOverrides(provisions, callback)
}

/**
 * Runs a callback that keeps the current overrides after the current scope
 * closes.
 *
 * The overrides are applied again in new scopes, which are cleaned up after
 * the callback finishes.
 * Values handed over with `dispose` cannot be carried over.
 * Open an async generator with `createDetachedStream` instead.
 */
export function runDetached<TCallbackResult>(
  callback: (scope: Scope) => TCallbackResult,
): Promise<Awaited<TCallbackResult>> {
  return globalRuntime.runDetached(callback)
}

/**
 * Opens an async source that keeps the current overrides for every read,
 * even after the current scope closes.
 *
 * `open` runs immediately, and its scopes close when the source finishes, a
 * read fails, the reader leaves, or `options.signal` aborts.
 * Pass the signal given to `open` to the operations inside the source so that
 * they stop promptly when the stream closes.
 * After that signal aborts, an error that is its `reason` or is named
 * `AbortError` ends the stream normally.
 * After external cancellation, await `return()` or `Symbol.asyncDispose` to
 * wait for cleanup and see its errors.
 */
export function createDetachedStream<T>(
  open: (scope: Scope, signal: AbortSignal) => AsyncIterable<T>,
  options?: DetachedStreamOptions,
): DetachedStream<T> {
  return globalRuntime.createDetachedStream(open, options)
}

/**
 * Creates a runner that applies the same overrides to each call in a scope
 * of its own.
 *
 * `factory` runs again for every call, so each call can hand over values of
 * its own.
 */
export function createOverrideRunner(factory: ProvisionFactory): OverrideRunner {
  return globalRuntime.createOverrideRunner(factory)
}

/**
 * Creates a helper that provides a value for one dependency during a
 * callback.
 *
 * Use it for a replacement repeated in several places.
 * Ownership options given here apply to every value the helper receives.
 */
export function createValueOverride<T>(
  dependency: DependencyToken<T>,
  options?: ProvideOptions<NoInfer<T>>,
): ValueOverride<T> {
  return globalRuntime.createValueOverride(dependency, options)
}

/**
 * Shuts the built-in runtime down when the application stops.
 *
 * Closes the installation and every scope, and cleans up every value the
 * runtime still owns.
 * The runtime cannot be used afterward, so do not call it between tests.
 */
export function dispose(): Promise<void> {
  return globalRuntime.dispose()
}
