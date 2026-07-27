# Ripple DI Agent Guide

## Overview

Ripple DI provides scoped dependency injection for TypeScript applications.
Application code imports its dependencies and reads them as normal function calls, while wiring and overrides stay at context boundaries.

A Dependency is a callable definition such as `useConfig` or `useDb`.
A Runtime owns one independent set of Dependency definitions, cached values, resources, and shutdown lifecycle.
A Scope is an inherited view inside a Runtime that applies a fixed set of overrides without mutating its parent.
An Installation is a long-lived immutable Scope overlay used as the Runtime's default application wiring.

Factories record the Dependencies they actually call.
An override recreates only the affected part of the graph, while unrelated values keep their existing identity.
Each resource is disposed by the Scope that owns it, and closing a Scope also closes its descendants.

Module-level functions delegate to one built-in global Runtime, so the usual single-Runtime application does not create a Runtime explicitly.

Read [README.md](README.md) completely before changing the public API, resolution or reuse behavior, lifecycle, or user documentation.

## Scope

- Keep production code in `src/`.
- Use `src/*.test.ts` only for focused tests of one source module.
- Keep subsystem, package-boundary, and type-inference tests in `tests/`.
- Keep `src/index.ts` as exports only.

## Source map

- `errors.ts` defines the public diagnostic error hierarchy.
- `dependency.ts` defines the public Dependency contract, creates callable definitions, and owns their private metadata.
- `provide.ts` defines typed provisions and owns their private metadata.
- `graph.ts` defines the internal provider, stamp, Cell, and context model.
- `evaluation.ts` owns the module-local synchronous factory stack shared by the copy's Runtime instances.
- `resolution.ts` implements provider lookup, tracking, validation, promotion, and cycle detection.
- `runtime.ts` defines the Runtime and Installation contracts and owns Runtime creation, Dependency definitions, callable routing, root installation, and the module-level API.
- `scope.ts` defines the Scope contract and owns provision validation and binding, async context, and lifecycle boundaries.

Keep `index.ts` limited to explicit public exports because owner modules also export symbols for internal collaboration.
Do not collapse these responsibilities into a generic `internal.ts` module.

## Architecture

Every Dependency belongs to the Runtime that defined it.
Dependencies and Provisions cannot cross Runtime boundaries.
Runtime state, default bindings, cells, resources, and lifecycle are never shared between Runtime instances.

Scopes have immutable provider bindings and mutable caches and lifecycle state.
Direct values resolve through BindingStamp identity without creating Cells.
Computed values and resources resolve through CellStamp identity and record only direct callable dependency reads.
Computed values and resources are reused whenever their provider and recorded Dependency stamps still match.

- Model scope-local values through explicit Dependency bindings; do not add a separate per-scope sharing mode.
- Model an active Installation as one immutable child of the root selected as the default base Scope.
  Reject installation while another Installation or any earlier Scope is unfinished.
  Detach it as the default before force-closing its complete subtree.
  Track the detached Installation until close settles so a replacement attempt reports pending cleanup separately from unrelated live Scopes.
- Keep Scope ancestry out of the public Scope contract so typed Scope handles cannot expose an Installation or the Runtime root.
  Treat concrete ScopeImpl properties as internal implementation state, not as a hardened JavaScript capability boundary.
- The module-local synchronous evaluation stack is shared by every Runtime created by one package copy.
- Do not add process-wide state, `globalThis` writes, `Symbol.for` registry keys, or cross-copy protocols.
  Callable reads across separately loaded copies are outside supported graph composition and intentionally remain undetected.
- Callable dispatch order is factory frame, the owning Runtime's AsyncLocalStorage, then the owning Runtime's root Scope.
- Runtime convenience methods use the same current Scope selection.
- Keep every Runtime method available as a module-level function that delegates to the built-in global Runtime.
- Filled scope view caches are never invalidated.
- Only a Cell owner registers and runs its resource disposer.
- Register directly supplied owned values during Scope creation so they are disposed even when unread.

## Contracts

- Factories are synchronous and async factories are rejected.
  Keep `defineComputed(compute, options?)` and `defineResource(create, options?)` factory-first.
  Factories may resolve Dependencies from their current Scope but cannot manage Installation or Scope context and lifecycle in their own Runtime.
- Values passed to `provide` are borrowed unless `options.dispose` transfers ownership to the receiving Scope or Installation.
  Keep `options.dispose: true` as reuse of the Dependency's configured disposer and reject it when no disposer is configured.
  An explicit `options.dispose` callback applies to the supplied value instead of the Dependency's configured disposer.
  An owned-value Provision can be installed for only one Scope or Installation; borrowed-value and factory Provisions remain reusable.
  Values created by `provideFactory` are owned by the receiving Scope or Installation and use the Dependency's configured disposer.
- Disposers and their async descendants cannot resolve Dependencies or manage Installations or Scopes in the Runtime being closed.
  Run them with their closing owner as both the ambient Scope and teardown context.
  All teardown errors are aggregated after cleanup continues.
- Check Installation lifecycle guards on every `close()` call, including calls after close has settled.
  Keep close bookkeeping in the returned promise chain so ignored teardown failures remain unhandled rejections.
- Overrides create child scopes and never mutate existing scopes.
  Installed providers use the same immutable bindings, dependency tracking, ownership, and disposal rules as scoped overrides.
  `Runtime.dispose()` force-closes its complete Scope tree.
  `retire()` waits for live descendants, while `close()` force-closes the subtree.
- Do not add live mutation, signal effects, async resolution, previous-binding decorators, or cross-scope factory reads to the core API.

## Documentation

- Write public README and JSDoc text for an application developer who does not know Ripple DI internals.
- Keep terms such as CellStamp, BindingStamp, provider home, and evaluation frame out of public explanations.
- Do not document obvious or implied defaults.
- Describe a default only when readers need it to make a decision or avoid surprising behavior.
- Use OSPL for connected prose.
- Keep semantically connected explanations as prose paragraphs.
- Use lists for separate assertions instead of presenting them as prose paragraphs.

## Tests

- `tests/api.test.ts` covers consumer syntax and public type inference.
- `tests/runtime.test.ts` covers Runtime APIs, installation semantics, isolation, and cross-Runtime boundaries.
- `tests/resolution.test.ts` covers tracking, promotion, and resolution errors.
- `tests/scope-lifecycle.test.ts` covers Scope creation, async context, ownership, disposal, retirement, close, and leaked scopes.
- `tests/model-based.test.ts` compares generated graphs with a deterministic reference resolver.

- Use semantic names instead of ordinal placeholders such as `first` and `second`.
- Keep model seeds deterministic and include the seed in failure messages.

## Checks

- Run `bun test` for the directed and deterministic model-based suites.
- Run `bun types` to type-check production code and tests when public types change.
- Run `bun run build` for package export, declaration, publint, and arethetypeswrong validation.
