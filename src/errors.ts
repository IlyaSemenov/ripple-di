import type { ScopeState } from "./scope"

/** Base class for errors thrown by Ripple DI. */
export class RippleError extends Error {}

/** The Dependency was requested without a provided value or default factory. */
export class MissingProviderError extends RippleError {
  constructor(
    readonly dependencyName: string,
    readonly path: readonly string[],
  ) {
    super(
      path.length > 1
        ? `Dependency "${dependencyName}" has no provider while resolving ` +
            `${path.join(" \u2192 ")}.`
        : `Dependency "${dependencyName}" has no provider.`,
    )
    this.name = "MissingProviderError"
  }
}

/** A Dependency was used with a different Runtime than the one that defined it. */
export class CrossRuntimeDependencyError extends RippleError {
  constructor(
    readonly dependencyName: string,
    readonly dependencyRuntimeName: string,
    readonly requestedRuntimeName: string,
  ) {
    super(
      dependencyRuntimeName === requestedRuntimeName
        ? `Dependency "${dependencyName}" belongs to a different Runtime ` +
            `instance also named "${dependencyRuntimeName}".`
        : `Dependency "${dependencyName}" belongs to Runtime ` +
            `"${dependencyRuntimeName}" and cannot be used in Runtime ` +
            `"${requestedRuntimeName}".`,
    )
    this.name = "CrossRuntimeDependencyError"
  }
}

/** `install()` was called while another installation or scope was unfinished. */
export class InstallationConflictError extends RippleError {
  constructor(
    readonly runtimeName: string,
    readonly reason:
      | "active-installation"
      | "closing-installation"
      | "live-scopes",
    readonly scopeNames: readonly string[] = [],
  ) {
    super(
      reason === "active-installation"
        ? `Runtime "${runtimeName}" already has an active installation. ` +
            "Close it before calling install() again."
        : reason === "closing-installation"
          ? `Runtime "${runtimeName}" is still closing its previous ` +
            "installation. Await Installation.close() before calling " +
            "install() again."
          : `Runtime "${runtimeName}" still has unfinished ` +
            `${scopeNames.length === 1 ? "scope" : "scopes"}: ` +
            `${scopeNames.map((name) => `"${name}"`).join(", ")}. ` +
            `Close ${scopeNames.length === 1 ? "it" : "them"} before ` +
            "calling install().",
    )
    this.name = "InstallationConflictError"
  }
}

/** The same Dependency appears more than once in one provision list. */
export class DuplicateProviderError extends RippleError {
  constructor(readonly dependencyName: string) {
    super(
      `Dependency "${dependencyName}" has more than one provision in the same scope.`,
    )
    this.name = "DuplicateProviderError"
  }
}

/** One owned-value Provision was installed for more than one owner. */
export class OwnedProvisionReuseError extends RippleError {
  constructor(readonly dependencyName: string) {
    super(
      `The owned-value Provision for Dependency "${dependencyName}" has ` +
        "already been installed in a Scope or Installation.",
    )
    this.name = "OwnedProvisionReuseError"
  }
}

/** Dependency factories called one another in a cycle. */
export class DependencyCycleError extends RippleError {
  constructor(readonly path: readonly string[]) {
    super(`Dependency cycle: ${path.join(" \u2192 ")}.`)
    this.name = "DependencyCycleError"
  }
}

/** A Dependency factory returned a Promise or thenable instead of a value. */
export class AsyncFactoryError extends RippleError {
  constructor(
    readonly dependencyName: string,
    readonly path: readonly string[],
  ) {
    super(
      `Factory for dependency "${dependencyName}" returned a Promise or thenable ` +
        `while resolving ${path.join(" \u2192 ")}.`,
    )
    this.name = "AsyncFactoryError"
  }
}

/** A Dependency factory threw an error available through this error's `cause`. */
export class FactoryError extends RippleError {
  constructor(
    readonly dependencyName: string,
    readonly path: readonly string[],
    cause: unknown,
  ) {
    super(
      `Factory for dependency "${dependencyName}" failed while resolving ` +
        `${path.join(" \u2192 ")}.`,
      { cause },
    )
    this.name = "FactoryError"
  }
}

/** An operation tried to use a scope that is retiring, closing, or closed. */
export class ScopeClosedError extends RippleError {
  constructor(
    readonly targetName: string,
    readonly scopeName: string,
    readonly scopeId: number,
    readonly state: ScopeState,
  ) {
    super(
      `Scope "${scopeName}" (#${scopeId}) is ${state}; ` +
        `cannot use "${targetName}".`,
    )
    this.name = "ScopeClosedError"
  }
}

/** A factory tried to read explicitly from a different scope. */
export class CrossScopeResolutionError extends RippleError {
  constructor(
    readonly dependencyName: string,
    readonly factoryScopeName: string,
    readonly requestedScopeName: string,
  ) {
    super(
      `Factory in scope "${factoryScopeName}" cannot explicitly resolve ` +
        `"${dependencyName}" from scope "${requestedScopeName}".`,
    )
    this.name = "CrossScopeResolutionError"
  }
}

/** A Dependency factory tried to manage Runtime context or lifecycle. */
export class FactoryScopeOperationError extends RippleError {
  constructor(
    readonly dependencyName: string,
    readonly operation: string,
  ) {
    super(
      `Factory for Dependency "${dependencyName}" cannot call ${operation}.`,
    )
    this.name = "FactoryScopeOperationError"
  }
}

/** Code running in or started by a disposer used the Runtime being closed. */
export class DisposerContextError extends RippleError {
  constructor(
    readonly targetName: string,
    readonly scopeName: string,
    readonly scopeId: number,
  ) {
    super(
      `Cannot use "${targetName}" from code running in or started by a ` +
        `disposer for Scope "${scopeName}" (#${scopeId}).`,
    )
    this.name = "DisposerContextError"
  }
}

/**
 * A `withOverrides` callback created child scopes and returned without closing
 * them.
 *
 * Ripple DI force-closes the leaked scopes before throwing this error.
 */
export class LeakedChildScopeError extends RippleError {
  constructor(
    readonly scopeName: string,
    readonly leakedChildCount: number,
  ) {
    super(
      `Scope "${scopeName}" leaked ${leakedChildCount} child ` +
        `${leakedChildCount === 1 ? "scope" : "scopes"}.`,
    )
    this.name = "LeakedChildScopeError"
  }
}
