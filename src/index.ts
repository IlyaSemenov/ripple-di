import * as local from "./api"
import { selectImplementation } from "./sharing"

export type * from "./api"

// Every value export comes from one selected implementation so that metadata,
// tracking, lifecycle, and error classes stay consistent across shared copies.
export const {
  AsyncFactoryError,
  AsyncMemoError,
  asValue,
  CrossRuntimeDependencyError,
  CrossScopeResolutionError,
  collectProvisions,
  createDetachedStream,
  createOverrideRunner,
  createRuntime,
  createScope,
  createValueOverride,
  DependencyCycleError,
  DetachedContextOwnedProvisionError,
  DisposerContextError,
  DuplicateProviderError,
  defineDependency,
  defineFactoryDependency,
  dispose,
  FactoryError,
  FactoryScopeOperationError,
  InstallationConflictError,
  install,
  LeakedChildScopeError,
  MemoCycleError,
  MemoScopeOperationError,
  MissingProviderError,
  memo,
  memoize,
  OwnedProvisionReuseError,
  provide,
  provideFactory,
  RippleError,
  resolve,
  runDetached,
  ScopeClosedError,
  withOverrides,
  withoutProvider,
} = selectImplementation(local)

// A local value export hides the same-named class type re-exported above, so
// each error class restores its instance type explicitly.
export type AsyncFactoryError = local.AsyncFactoryError
export type AsyncMemoError = local.AsyncMemoError
export type CrossRuntimeDependencyError = local.CrossRuntimeDependencyError
export type CrossScopeResolutionError = local.CrossScopeResolutionError
export type DependencyCycleError = local.DependencyCycleError
export type DetachedContextOwnedProvisionError =
  local.DetachedContextOwnedProvisionError
export type DisposerContextError = local.DisposerContextError
export type DuplicateProviderError = local.DuplicateProviderError
export type FactoryError = local.FactoryError
export type FactoryScopeOperationError = local.FactoryScopeOperationError
export type InstallationConflictError = local.InstallationConflictError
export type LeakedChildScopeError = local.LeakedChildScopeError
export type MemoCycleError = local.MemoCycleError
export type MemoScopeOperationError = local.MemoScopeOperationError
export type MissingProviderError = local.MissingProviderError
export type OwnedProvisionReuseError = local.OwnedProvisionReuseError
export type RippleError = local.RippleError
export type ScopeClosedError = local.ScopeClosedError
