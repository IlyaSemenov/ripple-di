declare const asValueBrand: unique symbol

/**
 * A factory result marked as the dependency value itself.
 *
 * Create it with `asValue`.
 */
export interface AsValue<T> {
  readonly [asValueBrand]: (value: T) => T
}

/** What a dependency factory may return: the value, or a marked value. */
export type FactoryResult<T> = T | AsValue<T>

/** Boxed payload, so that `undefined` and `null` stay markable. */
interface MarkedValue {
  readonly value: unknown
}

const markedValues = new WeakMap<object, MarkedValue>()

/**
 * Uses a factory result as the dependency value even when it is a `Promise`.
 *
 * A factory that returns a promise is normally rejected, because dependency
 * reads made after an `await` are not tracked.
 * Wrap the result when the promise itself is the value the dependency holds.
 * A value that merely implements `then`, such as a query builder, is an
 * ordinary value and does not need this.
 */
export function asValue<T>(value: T): AsValue<T> {
  const marked = {} as AsValue<T>
  markedValues.set(marked, { value })
  return marked
}

/** Returns the boxed payload, or `undefined` for an ordinary factory result. */
export function markedValueOf(result: unknown): MarkedValue | undefined {
  return typeof result === "object" && result !== null
    ? markedValues.get(result)
    : undefined
}
