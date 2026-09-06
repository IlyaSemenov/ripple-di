import { nodeOf } from "./dependency"
import { DetachedContextOwnedProvisionError, ScopeClosedError } from "./errors"
import type { BoundProvider, ScopeContext } from "./graph"
import { scopeParent } from "./graph"
import {
  type Provision,
  provide,
  provideFactory,
  withoutProvider,
} from "./provide"
import {
  closeTemporaryScopes,
  collectError,
  throwCollected,
  withChildScope,
} from "./scope"

/** Reproduces the current scope layers beneath a separate lifecycle parent. */
export async function runDetachedScopeContext<TCallbackResult>(
  base: ScopeContext,
  current: ScopeContext,
  callback: (scope: ScopeContext) => TCallbackResult,
): Promise<Awaited<TCallbackResult>> {
  const snapshots = snapshotDetachedLayers(base, current, "Runtime.runDetached")
  const layers = snapshots.length > 0 ? snapshots : [[]]
  return await replayDetachedLayers(base, layers, 0, callback)
}

/** Captures immutable provider recipes without retaining scope caches. */
function snapshotDetachedLayers(
  base: ScopeContext,
  current: ScopeContext,
  operation: string,
): readonly (readonly Provision[])[] {
  if (current.state !== "active") {
    throw new ScopeClosedError(
      operation,
      current.name,
      current.id,
      current.state,
    )
  }

  const scopes: ScopeContext[] = []
  let cursor: ScopeContext | undefined = current

  while (cursor !== base) {
    if (!cursor) {
      throw new Error(
        `Scope "${current.name}" is not beneath base scope "${base.name}".`,
      )
    }
    if (cursor.state === "closing" || cursor.state === "closed") {
      throw new ScopeClosedError(
        operation,
        cursor.name,
        cursor.id,
        cursor.state,
      )
    }
    scopes.push(cursor)
    cursor = cursor[scopeParent]
  }

  scopes.reverse()

  for (const scope of scopes) {
    for (const binding of scope.bindings.values()) {
      if (binding.spec.kind === "owned-value") {
        throw new DetachedContextOwnedProvisionError(
          nodeOf(binding.stamp.dependency).name,
          scope.name,
        )
      }
    }
  }

  return scopes.map((scope) =>
    [...scope.bindings.values()].map(reproduceProvision),
  )
}

/** Turns an installed binding back into the provision that created it. */
function reproduceProvision(binding: BoundProvider<unknown>): Provision {
  const { dependency } = binding.stamp
  switch (binding.spec.kind) {
    case "missing":
      return withoutProvider(dependency)
    case "factory":
      return provideFactory(dependency, binding.spec.factory)
    case "value":
      return provide(dependency, binding.spec.value)
    case "owned-value":
      throw new Error(
        "ripple-di lost an owned-value provision in a detached layer.",
      )
  }
}

/** Enters reproduced layers from the original outermost layer inward. */
async function replayDetachedLayers<TCallbackResult>(
  parent: ScopeContext,
  layers: readonly (readonly Provision[])[],
  index: number,
  callback: (scope: ScopeContext) => TCallbackResult,
): Promise<Awaited<TCallbackResult>> {
  const provisions = layers[index]
  if (!provisions) {
    throw new Error("ripple-di lost a detached context layer.")
  }
  return await withChildScope(parent, provisions, (scope) =>
    index === layers.length - 1
      ? callback(scope)
      : replayDetachedLayers(scope, layers, index + 1, callback),
  )
}

/**
 * An async source whose reads keep the dependency context it was opened in
 * until it finishes or the reader closes it.
 */
export type DetachedStream<T> = AsyncIterable<T> & AsyncDisposable

/** Controls cancellation of a detached stream. */
export interface DetachedStreamOptions {
  /** Cancels the source and starts cleanup even if the stream has never been read. */
  signal?: AbortSignal
}

/**
 * Opens an async source inside reproduced scope layers that stay open until
 * the reader is done with it.
 *
 * Snapshot failures throw before any scope exists. The `open` callback runs
 * synchronously inside the innermost reproduced scope, and so does every
 * iterator step afterward.
 */
export function createDetachedScopeStream<T>(
  base: ScopeContext,
  current: ScopeContext,
  open: (scope: ScopeContext, signal: AbortSignal) => AsyncIterable<T>,
  { signal }: DetachedStreamOptions = {},
): DetachedStream<T> {
  const layers = snapshotDetachedLayers(
    base,
    current,
    "Runtime.createDetachedStream",
  )
  const outermost = base.createScope(layers[0] ?? [])
  let innermost = outermost
  for (const provisions of layers.slice(1)) {
    innermost = innermost.createScope(provisions)
  }
  const failureMessage = `Errors in detached stream "${innermost.name}".`

  const controller = new AbortController()
  let source: AsyncIterator<T>
  let opened = false
  let stopped = false
  const finished: IteratorResult<T, undefined> = {
    done: true,
    value: undefined,
  }
  let closing: Promise<void> | undefined
  let finishing: Promise<IteratorResult<T, undefined>> | undefined
  const pending = new Set<Promise<IteratorResult<T>>>()

  /** Stops new reads before notifying cancellation listeners, which may reenter the stream. */
  function stop(reason?: unknown): void {
    stopped = true
    signal?.removeEventListener("abort", onAbort)
    controller.abort(reason)
  }

  /** Recognizes source cancellation before cleanup itself aborts the signal. */
  function isCancellation(error: unknown): boolean {
    const { signal } = controller
    // Node primitives can throw their own AbortError instead of signal.reason.
    return (
      signal.aborted &&
      (error === signal.reason ||
        (error as { name?: unknown } | null | undefined)?.name === "AbortError")
    )
  }

  function close(): Promise<void> {
    // Publish the shared cleanup promise before notifying application code.
    closing ??= Promise.resolve().then(async () => {
      const errors: unknown[] = []
      await closeTemporaryScopes(outermost, innermost, errors)
      throwCollected(errors, failureMessage)
    })
    stop()
    return closing
  }

  /** Releases the scopes and reports the given errors together with teardown failures. */
  async function release(
    errors: unknown[],
  ): Promise<IteratorResult<T, undefined>> {
    try {
      await close()
    } catch (error) {
      collectError(errors, error)
    }
    throwCollected(errors, failureMessage)
    return finished
  }

  /** Runs one read in the source scope and releases the scopes once the source is done or failed. */
  async function advance(
    operation: () => Promise<IteratorResult<T>>,
  ): Promise<IteratorResult<T, undefined>> {
    let result: IteratorResult<T> = finished
    const errors: unknown[] = []
    try {
      const step = innermost.run(operation)
      pending.add(step)
      try {
        result = await step
      } finally {
        pending.delete(step)
      }
    } catch (error) {
      if (!isCancellation(error)) errors.push(error)
    }

    // Cancellation owns cleanup until return() and all outstanding source
    // operations settle; a concurrent next() must not dispose their resources.
    if (finishing) {
      try {
        await finishing
      } catch (error) {
        collectError(errors, error)
      }
      throwCollected(errors, failureMessage)
      // A read started before cancellation still delivers its successful value.
      return result.done ? finished : result
    }
    return errors.length > 0 || result.done ? release(errors) : result
  }

  /** Cancels reads, waits for source finalization in its scope, then releases the scopes. */
  function finish(reason?: unknown): Promise<IteratorResult<T, undefined>> {
    if (finishing) {
      return finishing
    }
    if (closing) {
      return closing.then(
        () => finished,
        () => finished,
      )
    }
    // Assign before aborting: abort listeners can call return() recursively.
    finishing = Promise.resolve().then(async () => {
      const errors: unknown[] = []
      // A force-closed scope cannot run the source's cleanup any more.
      if (innermost.state === "active") {
        try {
          await innermost.run(() => source.return?.())
        } catch (error) {
          if (!isCancellation(error)) errors.push(error)
        }
        // Custom iterators need not serialize return() behind pending reads.
        // Their non-cancellation failures remain observable through the corresponding calls.
        await Promise.allSettled(pending)
      }
      return release(errors)
    })
    stop(reason)
    return finishing
  }

  /** Starts cancellation without an awaiting caller; return/asyncDispose observes its errors. */
  function onAbort(): void {
    if (opened) {
      void finish(signal?.reason).catch(() => {})
    } else {
      // Cancellation may happen before or synchronously inside open().
      stop(signal?.reason)
    }
  }

  const stream: AsyncIterator<T, undefined> & DetachedStream<T> = {
    next: () =>
      stopped ? Promise.resolve(finished) : advance(() => source.next()),
    return: () => finish(),
    throw: (error) =>
      stopped
        ? Promise.reject(error)
        : advance(() =>
            source.throw ? source.throw(error) : Promise.reject(error),
          ),
    [Symbol.asyncIterator]: () => stream,
    [Symbol.asyncDispose]: async () => {
      await finish()
    },
  }

  signal?.addEventListener("abort", onAbort, { once: true })
  if (signal?.aborted) {
    onAbort()
  }
  try {
    source = innermost.run(() =>
      open(innermost, controller.signal)[Symbol.asyncIterator](),
    )
    opened = true
  } catch (error) {
    // Nobody receives the stream, so teardown failures can only surface as
    // unhandled rejections.
    void close()
    throw error
  }
  if (stopped) {
    onAbort()
  }
  return stream
}
