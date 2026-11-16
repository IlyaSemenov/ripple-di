import {
  type AnyFactory,
  captureDefinitionSite,
  type Dependency,
  type DependencyOptions,
  type DependencyToken,
  type FactoryDependency,
  type FactoryDependencyOptions,
} from "./dependency"
import type { DetachedStream, DetachedStreamOptions } from "./detached"
import type { DependencyInspection } from "./inspection"
import type { OverrideRunner, ProvisionFactory, ValueOverride } from "./overrides"
import type { ProvideOptions, ProvisionCollectionInput, ProvisionInput } from "./provide"
import { type Installation, RuntimeImpl } from "./runtime"
import type { Scope } from "./scope"
import type { FactoryResult } from "./value"

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
 * Lists the dependencies that the value of a dependency in the current scope
 * was built from.
 *
 * Reads the value first, as `resolve` does, so it is built if needed.
 */
export function inspectDependency<T>(dependency: DependencyToken<T>): DependencyInspection {
  return globalRuntime.inspectDependency(dependency)
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
