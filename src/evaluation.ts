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

export type TrackingFrame = EvaluationFrame | MemoTrackingFrame

const trackingStack: TrackingFrame[] = []
const evaluationStack: EvaluationFrame[] = []

export function currentTracking(): TrackingFrame | undefined {
  return trackingStack.at(-1)
}

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
    (!tracking.runtime || tracking.runtime === runtime)
  ) {
    throw new MemoScopeOperationError(tracking.name, operation)
  }

  const frame = currentEvaluation()
  if (frame?.runtime === runtime) {
    throw new FactoryScopeOperationError(frame.node.name, operation)
  }
}

export function pushEvaluation(frame: EvaluationFrame): void {
  trackingStack.push(frame)
  evaluationStack.push(frame)
}

export function popEvaluation(frame: EvaluationFrame): void {
  if (evaluationStack.pop() !== frame || trackingStack.pop() !== frame) {
    throw new Error("ripple-di evaluation stack became inconsistent.")
  }
}

export function pushTracking(frame: TrackingFrame): void {
  trackingStack.push(frame)
}

export function popTracking(frame: TrackingFrame): void {
  if (trackingStack.pop() !== frame) {
    throw new Error("ripple-di tracking stack became inconsistent.")
  }
}

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

export function resolutionPath(
  ending?: DependencyNode<unknown>,
): readonly string[] {
  const path = evaluationStack.map((frame) => frame.node.name)
  if (ending && evaluationStack.at(-1)?.node !== ending) {
    path.push(ending.name)
  }
  return path
}

export function framesFrom(index: number): readonly EvaluationFrame[] {
  return evaluationStack.slice(index)
}

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
