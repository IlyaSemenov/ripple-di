import { isPromise } from "node:util/types"

import { AsyncMemoError, MemoCycleError } from "./errors"
import {
  currentTracking,
  type MemoTrackingFrame,
  memoCyclePath,
  popTracking,
  pushTracking,
} from "./evaluation"
import type { DependencyIdentityRecord } from "./graph"
import {
  propagateTrackedDependencies,
  reuseTrackedDependencies,
} from "./resolution"

interface MemoCell<T> {
  readonly value: T
  readonly dependencies: readonly DependencyIdentityRecord[]
}

type ZeroArgumentMethod<TMethod extends (...args: any[]) => any> =
  Parameters<TMethod> extends [] ? TMethod : never

/**
 * Memoizes a zero-argument synchronous computation by its receiver and the
 * Ripple dependencies it reads.
 */
export function memoize<TResult>(
  computation: (this: void) => TResult,
): () => TResult
export function memoize<TObject extends object, TResult>(
  computation: (this: TObject) => TResult,
): (this: TObject) => TResult
export function memoize<TResult>(
  computation: (this: object | undefined) => TResult,
): (this: object | undefined) => TResult {
  return createMemoized(computation, memoNameOf(computation.name))
}

function createMemoized<TReceiver extends object | undefined, TResult>(
  computation: (this: TReceiver) => TResult,
  name: string,
): (this: TReceiver) => TResult {
  const objectCells = new WeakMap<object, MemoCell<TResult>>()
  let standaloneCell: MemoCell<TResult> | undefined
  const identity = Symbol(name)

  return function memoized(this: TReceiver): TResult {
    if (arguments.length !== 0) {
      throw new TypeError("A dependency-aware memo does not accept arguments.")
    }
    if (
      this === null ||
      (this !== undefined &&
        typeof this !== "object" &&
        typeof this !== "function")
    ) {
      throw new TypeError(
        "A dependency-aware memo requires an object receiver.",
      )
    }

    const receiver = this ?? undefined
    const cyclePath = memoCyclePath(identity, receiver, name)
    if (cyclePath) {
      throw new MemoCycleError(cyclePath)
    }
    const cached = receiver ? objectCells.get(receiver) : standaloneCell
    if (cached && reuseTrackedDependencies(cached.dependencies)) {
      return cached.value
    }

    const consumer = currentTracking()
    const frame: MemoTrackingFrame = {
      kind: "memo",
      name,
      identity,
      receiver,
      runtime: consumer?.runtime,
      scope: consumer?.scope,
      dependencies: new Map(),
      hasFailedDependencyRead: false,
    }

    pushTracking(frame)
    let value: TResult
    try {
      value = Reflect.apply(computation, this, [])
      if (isPromise(value)) {
        throw new AsyncMemoError(name)
      }
    } finally {
      popTracking(frame)
      propagateTrackedDependencies(frame, consumer)
    }

    if (frame.hasFailedDependencyRead) {
      return value
    }

    const dependencies = [...frame.dependencies].map(([node, stamp]) => ({
      dependency: node.dependency,
      identity: stamp.identity,
    }))
    const cell = { value, dependencies }
    if (receiver) {
      objectCells.set(receiver, cell)
    } else {
      standaloneCell = cell
    }
    return value
  }
}

/** Standard decorator for a dependency-aware getter or zero-argument method. */
export function memo<TObject extends object, TResult>(
  value: (this: TObject) => TResult,
  context: ClassGetterDecoratorContext<TObject, TResult>,
): (this: TObject) => TResult
export function memo<
  TObject extends object,
  TMethod extends (this: TObject, ...args: any[]) => any,
>(
  value: ZeroArgumentMethod<TMethod>,
  context: ClassMethodDecoratorContext<TObject, TMethod>,
): TMethod
export function memo(
  value: (...args: never[]) => unknown,
  context: { readonly kind: string; readonly name: string | symbol },
): (...args: never[]) => unknown {
  if (context.kind !== "getter" && context.kind !== "method") {
    throw new TypeError("@memo can decorate only a getter or method.")
  }
  return createMemoized(value, memoNameOf(context.name))
}

function memoNameOf(name: string | symbol): string {
  if (typeof name === "symbol") {
    return name.description ? `Symbol(${name.description})` : name.toString()
  }
  return name.trim() || "memo computation"
}
