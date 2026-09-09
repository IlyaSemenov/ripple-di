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
import {
  assertOutsideTracking,
  currentEvaluation,
  currentTracking,
} from "./evaluation"
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
import {
  collectProvisions,
  type ProvideOptions,
  type ProvisionCollectionInput,
  type ProvisionInput,
} from "./provide"
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
export interface Installation extends AsyncDisposable {
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
export interface Runtime extends AsyncDisposable {
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
   * Defines an overrideable factory invoked with ordinary runtime arguments.
   *
   * Each call resolves the current factory and invokes it without caching or
   * owning the result.
   */
  defineFactoryDependency<TFactory extends AnyFactory>(
    factory: TFactory,
    options?: FactoryDependencyOptions,
  ): FactoryDependency<TFactory>

  /**
   * Defines an overrideable factory with no built-in implementation.
   *
   * Supply it through an installation or scope before calling it.
   */
  defineFactoryDependency<TFactory extends AnyFactory>(
    options?: FactoryDependencyOptions,
  ): FactoryDependency<TFactory>

  /**
   * Installs long-lived providers as the fallback beneath scoped overrides.
   *
   * A runtime can have one active installation, and previously created scopes
   * must be fully closed before this method is called.
   */
  install(...provisions: ProvisionCollectionInput[]): Installation

  /** Returns a dependency value from the current scope. */
  resolve<T>(dependency: DependencyToken<T>): T

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
   * Continues the current dependency context outside its original scope.
   *
   * The runtime reproduces every current override layer beneath its active
   * installation or root without copying cached dependency values.
   */
  runDetached<TCallbackResult>(
    callback: (scope: Scope) => TCallbackResult,
  ): Promise<Awaited<TCallbackResult>>

  /**
   * Opens an async source inside the current dependency context and keeps
   * that context for every read until the source finishes or the reader
   * closes the stream.
   *
   * Pass the signal from `open` to operations that need to stop promptly;
   * cancellation waits for operations without signal support to finish.
   * External cancellation and `return()` abort that signal immediately and
   * keep the scopes open until the source finishes cleanup.
   * A `throw()` that the source recovers from does not cancel the signal.
   * Source completion or failure also aborts the signal.
   * New reads after cancellation return `done`; pending reads keep their
   * values or non-cancellation errors.
   * A source error from a read or `return()` becomes `done` only when the
   * signal is aborted and the error equals `signal.reason` or has name `AbortError`.
   * All other source errors and every dependency cleanup error remain observable.
   * Await `return()` or `Symbol.asyncDispose` to observe background cleanup failures.
   */
  createDetachedStream<T>(
    open: (scope: Scope, signal: AbortSignal) => AsyncIterable<T>,
    options?: DetachedStreamOptions,
  ): DetachedStream<T>

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
    dependency: DependencyToken<T>,
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

  /**
   * Defines a dependency with a definition site captured by the caller.
   *
   * The module-level function delegates here so that the captured site is the
   * application's own call and not the delegating wrapper.
   */
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
    return runDetachedScopeContext(
      this.baseScope(),
      this.currentAmbientScope(),
      async (scope) => {
        const result = await callback(scope)
        if (isGeneratorObject(result)) {
          throw new TypeError(
            "runDetached callback returned a generator, which would " +
              "run after the detached context closes. Open the source with " +
              "createDetachedStream instead.",
          )
        }
        return result
      },
    )
  }

  createDetachedStream<T>(
    open: (scope: Scope, signal: AbortSignal) => AsyncIterable<T>,
    options?: DetachedStreamOptions,
  ): DetachedStream<T> {
    this.assertScopeManagementAllowed("Runtime.createDetachedStream")
    return createDetachedScopeStream(
      this.baseScope(),
      this.currentAmbientScope(),
      open,
      options,
    )
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
        throw new CrossRuntimeDependencyError(
          node.name,
          this.name,
          frame.runtime.name,
        )
      }
      return resolveTracked(
        frame.scope ?? this.ambient.getStore() ?? this.baseScope(),
        node,
      )
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

  [Symbol.asyncDispose](): Promise<void> {
    return this.close()
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
 * Defines an overrideable factory invoked with ordinary runtime arguments.
 *
 * Each call resolves the current factory and invokes it without caching or
 * owning the result.
 */
export function defineFactoryDependency<TFactory extends AnyFactory>(
  factory: TFactory,
  options?: FactoryDependencyOptions,
): FactoryDependency<TFactory>
/**
 * Defines an overrideable factory with no built-in implementation.
 *
 * Supply it through an installation or scope before calling it.
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
 * Installs long-lived providers for module-level dependencies.
 *
 * Scoped overrides still take priority. Close the returned installation to
 * remove its providers and clean up everything created from them.
 */
export function install(
  ...provisions: ProvisionCollectionInput[]
): Installation {
  return globalRuntime.install(...provisions)
}

/** Returns a dependency value from the current scope. */
export function resolve<T>(dependency: DependencyToken<T>): T {
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
 * Continues the current dependency context outside its original scope.
 *
 * Current override layers are reproduced beneath the active installation or
 * runtime root without copying cached values, and are cleaned up after the
 * callback finishes.
 */
export function runDetached<TCallbackResult>(
  callback: (scope: Scope) => TCallbackResult,
): Promise<Awaited<TCallbackResult>> {
  return globalRuntime.runDetached(callback)
}

/**
 * Opens an async source that keeps the current dependency context for every
 * read.
 *
 * The source is opened immediately inside reproduced override layers, each
 * read runs inside them, and they are cleaned up when the source finishes or
 * the reader closes the stream.
 * External cancellation starts closing even an unread stream.
 *
 * Pass the signal from `open` to operations that need to stop promptly.
 * Cancellation waits for operations without signal support to finish;
 * an uninterruptible wait can keep cleanup pending indefinitely.
 * External cancellation and `return()` abort that signal immediately, stop
 * new reads, and keep the scopes open until source cleanup finishes.
 * The signal also aborts when the source finishes or fails, but remains
 * active after a `throw()` that the source recovers from.
 * After external cancellation, await `return()` or `Symbol.asyncDispose`
 * to observe cleanup failures; new reads return `done` immediately.
 * A source error from a read or `return()` becomes `done` only when the
 * signal is aborted and the error equals `signal.reason` or has name `AbortError`.
 * All other source errors and every dependency cleanup error remain observable.
 * Successful values from reads already in progress are preserved.
 */
export function createDetachedStream<T>(
  open: (scope: Scope, signal: AbortSignal) => AsyncIterable<T>,
  options?: DetachedStreamOptions,
): DetachedStream<T> {
  return globalRuntime.createDetachedStream(open, options)
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
  dependency: DependencyToken<T>,
  options?: ProvideOptions<NoInfer<T>>,
): ValueOverride<T> {
  return globalRuntime.createValueOverride(dependency, options)
}

/** Closes every scope and cleans up every owned value. */
export function dispose(): Promise<void> {
  return globalRuntime.dispose()
}
