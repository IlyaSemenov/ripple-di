import { FactoryScopeOperationError, MemoScopeOperationError } from "./errors"
import type {
  BindingStamp,
  DependencyNode,
  DependencyStamp,
  RuntimeContext,
  ScopeContext,
} from "./graph"

/** Synchronous dependency tracking shared by factories and memo computations. */
interface TrackingState {
  readonly name: string
  runtime: RuntimeContext | undefined
  scope: ScopeContext | undefined
  readonly dependencies: Map<DependencyNode<unknown>, DependencyStamp>
  hasFailedDependencyRead: boolean
}

/** Factory-specific frame used for cycle paths and lifecycle guards. */
export interface EvaluationFrame extends TrackingState {
  readonly kind: "factory"
  runtime: RuntimeContext
  scope: ScopeContext
  readonly node: DependencyNode<unknown>
  readonly providerStamp: BindingStamp
}

/** Memo-specific identity used only for synchronous recursion detection. */
export interface MemoTrackingFrame extends TrackingState {
  readonly kind: "memo"
  readonly identity: symbol
  readonly receiver: object | undefined
}

/** Active factory or memo computation whose dependency reads are recorded. */
export type TrackingFrame = EvaluationFrame | MemoTrackingFrame

// A factory frame goes on both stacks: tracking needs the complete nesting
// order, while factory cycle detection and resolution paths omit memos.
const trackingStack: TrackingFrame[] = []
const evaluationStack: EvaluationFrame[] = []

/** Innermost factory or memo computation, if one is running. */
export function currentTracking(): TrackingFrame | undefined {
  return trackingStack.at(-1)
}

/** Innermost factory, even when a nested memo is currently running. */
export function currentEvaluation(): EvaluationFrame | undefined {
  return evaluationStack.at(-1)
}

/** Rejects scope management while same-runtime synchronous tracking is active. */
export function assertOutsideTracking(
  runtime: RuntimeContext,
  operation: string,
): void {
  const tracking = currentTracking()
  if (
    tracking?.kind === "memo" &&
    // Without an inherited runtime or a prior read, a memo rejects scope
    // management in every runtime.
    (!tracking.runtime || tracking.runtime === runtime)
  ) {
    throw new MemoScopeOperationError(tracking.name, operation)
  }

  const frame = currentEvaluation()
  if (frame?.runtime === runtime) {
    throw new FactoryScopeOperationError(frame.node.name, operation)
  }
}

/** Enters a factory on both the tracking and factory stacks. */
export function pushEvaluation(frame: EvaluationFrame): void {
  trackingStack.push(frame)
  evaluationStack.push(frame)
}

/** Leaves a factory; throws if either stack no longer ends with this frame. */
export function popEvaluation(frame: EvaluationFrame): void {
  if (evaluationStack.pop() !== frame || trackingStack.pop() !== frame) {
    throw new Error("ripple-di evaluation stack became inconsistent.")
  }
}

/** Enters dependency tracking without adding a factory evaluation. */
export function pushTracking(frame: TrackingFrame): void {
  trackingStack.push(frame)
}

/** Leaves dependency tracking; throws if this frame is no longer innermost. */
export function popTracking(frame: TrackingFrame): void {
  if (trackingStack.pop() !== frame) {
    throw new Error("ripple-di tracking stack became inconsistent.")
  }
}

/** Index of the factory evaluating this dependency and provider identity, or -1. */
export function cycleStart(
  node: DependencyNode<unknown>,
  providerStamp: BindingStamp,
): number {
  return evaluationStack.findIndex(
    (frame) =>
      frame.node === node &&
      frame.providerStamp.identity === providerStamp.identity,
  )
}

/** Names active factories and appends the failed dependency when supplied. */
export function resolutionPath(
  ending?: DependencyNode<unknown>,
): readonly string[] {
  const path = evaluationStack.map((frame) => frame.node.name)
  // The failed dependency is already last when its own factory is running.
  if (ending && evaluationStack.at(-1)?.node !== ending) {
    path.push(ending.name)
  }
  return path
}

/** Frames from a cycle start to the innermost one, in call order. */
export function framesFrom(index: number): readonly EvaluationFrame[] {
  return evaluationStack.slice(index)
}

/**
 * Names the chain of memo computations that leads back to this one.
 *
 * Returns `undefined` when it is not already running. Dependency factories
 * between two memo frames are left out of the path.
 */
export function memoCyclePath(
  identity: symbol,
  receiver: object | undefined,
  endingName: string,
): readonly string[] | undefined {
  const start = trackingStack.findIndex(
    (frame) =>
      frame.kind === "memo" &&
      frame.identity === identity &&
      frame.receiver === receiver,
  )
  if (start < 0) {
    return undefined
  }
  return [
    ...trackingStack
      .slice(start)
      .filter((frame) => frame.kind === "memo")
      .map((frame) => frame.name),
    endingName,
  ]
}
