import { version } from "../package.json"
import type * as PublicApi from "./api"

/** Public API of one package copy, used as the implementation of a realm. */
export type Implementation = typeof PublicApi

/** Realm-wide record written only by the `ripple-di/shared` entry. */
interface SharedImplementation {
  readonly version: string
  readonly implementation: Implementation
}

// A registry symbol is the only identity separately loaded copies have in
// common. Keep the key and the `version` field stable across releases so any
// later copy can reject an incompatible record instead of misreading it.
const sharedImplementationKey = Symbol.for("ripple-di.shared-implementation")

/**
 * Reads the realm's shared implementation.
 *
 * Throws when it was registered by a different exact package version, because
 * internal metadata and protocols are compatible only within one release.
 */
function readSharedImplementation(): SharedImplementation | undefined {
  const record = (globalThis as Record<symbol, unknown>)[
    sharedImplementationKey
  ] as SharedImplementation | undefined
  if (record && record.version !== version) {
    throw new Error(
      `ripple-di ${version} cannot join the shared implementation registered ` +
        `by ripple-di ${String(record.version)}. Every copy loaded after ` +
        `"ripple-di/shared" must have exactly the same version.`,
    )
  }
  return record
}

/** Explains a value whose private metadata belongs to no known package copy. */
export function foreignMetadataError(kind: string): TypeError {
  return new TypeError(
    `Value is not a ${kind} created by this copy of ripple-di. ` +
      "If it came from ripple-di, the package may be installed or bundled " +
      "more than once. " +
      'Load "ripple-di/shared" before every copy to share one implementation.',
  )
}

/**
 * Selects the implementation exported by this copy's main entry.
 *
 * Without a shared record, the copy keeps its own implementation and writes no
 * global state.
 */
export function selectImplementation(local: Implementation): Implementation {
  return readSharedImplementation()?.implementation ?? local
}

/**
 * Publishes this copy's implementation for every copy loaded afterward.
 *
 * Registration is permanent for the realm. A copy of the same version finds
 * the existing record and leaves it unchanged.
 */
export function shareImplementation(local: Implementation): void {
  if (readSharedImplementation()) {
    return
  }
  Object.defineProperty(globalThis, sharedImplementationKey, {
    value: Object.freeze({ version, implementation: local }),
    enumerable: false,
    writable: false,
    configurable: false,
  })
}
