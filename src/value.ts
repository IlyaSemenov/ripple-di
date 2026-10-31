declare const asValueBrand: unique symbol

/**
 * A factory result marked as the dependency's value.
 *
 * Create it with `asValue`.
 */
export interface AsValue<T> {
  readonly [asValueBrand]: (value: T) => T
}

/** What a dependency factory returns: the value, or a value marked with `asValue`. */
export type FactoryResult<T> = T | AsValue<T>

/** Boxed payload, so that `undefined` and `null` stay markable. */
interface MarkedValue {
  readonly value: unknown
}

const markedValues = new WeakMap<object, MarkedValue>()

/**
 * Marks a promise returned by a factory as the dependency's value.
 *
 * A factory that returns a promise is otherwise rejected, because the
 * dependencies it calls after an `await` are not recorded.
 * A value that only implements `then`, such as a query builder, needs no
 * marking.
 */
export function asValue<T>(value: T): AsValue<T> {
  const marked = {} as AsValue<T>
  markedValues.set(marked, { value })
  return marked
}

/** Returns the boxed payload, or `undefined` for an ordinary factory result. */
export function markedValueOf(result: unknown): MarkedValue | undefined {
  return typeof result === "object" && result !== null ? markedValues.get(result) : undefined
}
