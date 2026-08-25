import type { DependencyNode, RuntimeContext } from "./graph"
import type { FactoryResult } from "./value"

declare const dependencyBrand: unique symbol

/**
 * A function that returns the dependency value for the current scope.
 *
 * Pass the same function to `provide` to replace its value or to
 * `scope.resolve` when you need to read from a specific scope.
 */
export type Dependency<T> = (() => T) & {
  readonly [dependencyBrand]: (value: T) => T
}

/** Cleans up a value when Ripple DI no longer needs it. */
export type Disposer<T> = (value: T) => void | Promise<void>

/** Optional diagnostics and cleanup for a dependency. */
export interface DependencyOptions<T> {
  /** Optional name used only in error messages and resolution paths. */
  readonly name?: string
  /**
   * Cleans up values owned by Ripple DI.
   *
   * This applies to the built-in factory, `provideFactory`, and values passed
   * through `provide` with `dispose: true`.
   * Plain values passed through `provide` remain borrowed.
   */
  readonly dispose?: Disposer<T>
}

let nextDependencyId = 1
const dependencyNodes = new WeakMap<object, DependencyNode<unknown>>()

/** Complete private recipe used to create one callable dependency definition. */
interface DependencyDefinition<T> {
  readonly name: string | undefined
  readonly definitionSite: string | undefined
  readonly runtime: RuntimeContext
  readonly defaultFactory: (() => FactoryResult<T>) | undefined
  readonly dispose: DependencyNode<T>["dispose"]
}

/** Fully initialized metadata object captured by its own callable dependency. */
class DependencyNodeImpl<T> implements DependencyNode<T> {
  readonly id = nextDependencyId++
  readonly name: string
  readonly runtime: RuntimeContext
  readonly defaultFactory: (() => FactoryResult<T>) | undefined
  readonly dispose: DependencyNode<T>["dispose"]
  readonly dependency: Dependency<T>

  constructor(definition: DependencyDefinition<T>) {
    const generatedName = `dependency#${this.id}`
    this.name =
      definition.name ??
      (definition.definitionSite
        ? `${generatedName} (${definition.definitionSite})`
        : generatedName)
    this.runtime = definition.runtime
    this.defaultFactory = definition.defaultFactory
    this.dispose = definition.dispose
    this.dependency = (() => this.runtime.readCallable(this)) as Dependency<T>
  }
}

/** Captures and reduces a definition stack before it enters private metadata. */
export function captureDefinitionSite(caller: Function): string | undefined {
  const error = new Error()
  const captureStackTrace =
    typeof Error.captureStackTrace === "function"
      ? Error.captureStackTrace
      : undefined
  if (captureStackTrace) {
    captureStackTrace(error, caller)
  }

  const frames = error.stack?.split("\n").slice(1) ?? []
  const skippedFrames = captureStackTrace ? frames : frames.slice(2)
  for (const frame of skippedFrames) {
    const site = definitionSiteFromFrame(frame)
    if (site) {
      return site
    }
  }
  return undefined
}

function definitionSiteFromFrame(frame: string): string | undefined {
  let location = frame.trim().replace(/^at\s+/, "")
  const openingParenthesis = location.lastIndexOf("(")
  if (openingParenthesis >= 0 && location.endsWith(")")) {
    location = location.slice(openingParenthesis + 1, -1)
  } else {
    const atSign = location.lastIndexOf("@")
    if (atSign >= 0) {
      location = location.slice(atSign + 1)
    }
    location = location.replace(/^async\s+/, "")
  }

  const match = /^(.*):(\d+):\d+$/.exec(location)
  if (!match || !match[1]) {
    return undefined
  }

  let file = match[1].replace(/^file:\/\//, "").replaceAll("\\", "/")
  try {
    file = decodeURI(file)
  } catch {
    // Keep the runtime's original path when it contains invalid URI escapes.
  }

  const workingDirectory = `${process.cwd().replaceAll("\\", "/")}/`
  if (file.startsWith(workingDirectory)) {
    file = file.slice(workingDirectory.length)
  }
  return `${file}:${match[2]}`
}

/** Creates a property-free callable whose metadata lives only in a `WeakMap`. */
export function createDependency<T>(
  definition: DependencyDefinition<T>,
): Dependency<T> {
  const node = new DependencyNodeImpl(definition)
  dependencyNodes.set(node.dependency, node as DependencyNode<unknown>)
  return node.dependency
}

export function nodeOf<T>(dependency: Dependency<T>): DependencyNode<T> {
  const node = dependencyNodes.get(dependency)
  if (!node) {
    throw new TypeError(
      "Value is not a dependency created by this copy of ripple-di. " +
        "If it came from ripple-di, the package may be installed or bundled " +
        "more than once.",
    )
  }
  return node as DependencyNode<T>
}
