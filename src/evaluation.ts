import { FactoryScopeOperationError } from "./errors"
import type {
  BindingStamp,
  DependencyNode,
  DependencyStamp,
  RuntimeContext,
  ScopeContext,
} from "./graph"

/** Synchronous tracking frame shared by every Runtime in this package copy. */
export interface EvaluationFrame {
  readonly runtime: RuntimeContext
  readonly scope: ScopeContext
  readonly node: DependencyNode<unknown>
  readonly providerStamp: BindingStamp
  readonly dependencies: Map<DependencyNode<unknown>, DependencyStamp>
  hasFailedDependencyRead: boolean
}

const evaluationStack: EvaluationFrame[] = []

export function currentEvaluation(): EvaluationFrame | undefined {
  return evaluationStack.at(-1)
}

/** Rejects Scope management while a synchronous factory frame is active. */
export function assertOutsideEvaluation(
  runtime: RuntimeContext,
  operation: string,
): void {
  const frame = currentEvaluation()
  if (frame?.runtime === runtime) {
    throw new FactoryScopeOperationError(frame.node.name, operation)
  }
}

export function pushEvaluation(frame: EvaluationFrame): void {
  evaluationStack.push(frame)
}

export function popEvaluation(frame: EvaluationFrame): void {
  if (evaluationStack.pop() !== frame) {
    throw new Error("ripple-di evaluation stack became inconsistent.")
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
