# Ripple DI Agent Guide

## Overview

Ripple DI provides scoped dependency injection for TypeScript applications.
Application code imports its dependencies and reads them as normal function calls, while wiring and overrides stay at context boundaries.

A dependency is a callable definition such as `useConfig` or `useDb`.
A runtime owns one independent set of dependency definitions, cached values, ownership, and shutdown lifecycle.
A scope is an inherited view inside a runtime that applies a fixed set of overrides without mutating its parent.
An installation is a long-lived immutable scope overlay used as the runtime's default application wiring.

Factories record the dependencies they actually call.
An override recreates only the affected part of the graph, while unrelated values keep their existing identity.
Cleanup belongs to the scope that owns a value, and closing a scope also closes its descendants.

Module-level functions delegate to one built-in global runtime, so the usual single-runtime application does not create a runtime explicitly.

Read [README.md](README.md) completely before changing the public API, resolution or reuse behavior, lifecycle, or user documentation.

## Scope

- Keep production code in `src/`.
- Use `src/*.test.ts` only for focused tests of one source module.
- Keep subsystem, package-boundary, and type-inference tests in `tests/`.
- Keep `src/index.ts` as exports only.

## Source map

- `errors.ts` defines the public diagnostic error hierarchy.
- `dependency.ts` defines the public `Dependency` contract, creates callable definitions, and owns their private metadata.
- `provide.ts` defines typed provisions and owns their private metadata.
- `value.ts` defines the public `asValue` marker for factory results and owns its private metadata.
- `graph.ts` defines the internal provider, stamp, `Cell`, and context model.
- `evaluation.ts` owns the module-local synchronous factory stack shared by the copy's runtime instances.
- `resolution.ts` implements provider lookup, tracking, validation, promotion, and cycle detection.
- `runtime.ts` defines the `Runtime` and `Installation` contracts and owns runtime creation, dependency definitions, callable routing, root installation, and the module-level API.
- `scope.ts` defines the `Scope` contract and owns provision validation and binding, async context, and lifecycle boundaries.
- `overrides.ts` defines the `OverrideRunner` and `ValueOverride` contracts and owns reusable override layers and helpers.

Keep `index.ts` limited to explicit public exports because owner modules also export symbols for internal collaboration.
Do not collapse these responsibilities into a generic `internal.ts` module.
Keep exported `RippleError` subclasses in `errors.ts`, even when only one subsystem throws them.
Keep non-public invariant errors next to the subsystem that owns the invariant.

## Architecture

Every dependency belongs to the runtime that defined it.
Dependencies and provisions cannot cross runtime boundaries.
Runtime state, built-in bindings, cells, and lifecycle are never shared between runtime instances.

Scopes have immutable provider bindings and mutable caches and lifecycle state.
Direct values resolve through `BindingStamp` identity without creating cells.
Factory-created values resolve through `CellStamp` identity and record only direct callable dependency reads.
Factory-created values are reused whenever their provider and recorded dependency stamps still match.

- Model scope-local values through explicit dependency bindings; do not add a separate per-scope sharing mode.
- Model an active installation as one immutable child of the root selected as the default base scope.
  Reject installation while another installation or any earlier scope is unfinished.
  Detach it as the default before force-closing its complete subtree.
  Track the detached installation until close settles so a replacement attempt reports pending cleanup separately from unrelated live scopes.
- Keep scope ancestry out of the public `Scope` contract so typed scope handles cannot expose an installation or the runtime root.
  Treat concrete `ScopeImpl` properties as internal implementation state, not as a hardened JavaScript capability boundary.
- The module-local synchronous evaluation stack is shared by every runtime created by one package copy.
- Do not add process-wide state, `globalThis` writes, `Symbol.for` registry keys, or cross-copy protocols.
  Callable reads across separately loaded copies are outside supported graph composition and intentionally remain undetected.
- Callable dispatch order is factory frame, the owning runtime's `AsyncLocalStorage`, then its active installation or root scope.
- `Runtime` convenience methods use the same current scope selection, except `withDetachedOverrides`, which creates a temporary child of the runtime's active installation or root and remains part of that base scope's lifecycle.
- Keep every `Runtime` method available as a module-level function that delegates to the built-in global runtime.
- Select dependency diagnostic names in this order: explicit `options.name`, non-empty `factory.name`, then `dependency#N` with the definition site captured at `defineDependency`.
- Filled scope view caches are never invalidated.
- Only a cell owner registers and runs its disposer.
- Register directly supplied owned values during scope creation so they are disposed even when unread.

## Contracts

- Factories are synchronous and a factory that returns an unmarked native promise is rejected.
  Do not replace promise detection with a structural `then` check.
  Keep the options-only overload of `defineDependency` before its factory-first overload so TypeScript reports invalid values against `() => T`.
  A factory passed as the first argument is the only way to define a built-in fallback; do not add `default`, `value`, or `initial` options.
  Factories may resolve dependencies from their current scope but cannot manage installation or scope context and lifecycle in their own runtime.
- A dependency disposer applies only to values owned by Ripple DI: its built-in factory, `provideFactory`, and `provide` with `dispose: true`.
  Values passed to plain `provide` are borrowed unless an explicit `options.dispose` callback transfers ownership to the receiving scope or installation.
  Keep `options.dispose: true` as reuse of the dependency's configured disposer and reject it when no disposer is configured.
  An explicit `options.dispose` callback applies to the supplied value instead of the dependency's configured disposer.
  Use `TypeError` for invalid immediate API arguments; reserve RippleError subclasses for resolution and lifecycle failures.
  An owned-value provision can be installed for only one scope or installation; borrowed-value and factory provisions remain reusable.
  Values created by `provideFactory` are owned by the receiving scope or installation and use the dependency's configured disposer.
- Accept one provision or a list of them wherever provisions are supplied, and normalize the input once in the scope-creation boundary rather than in each entry point.
- Disposers and their async descendants cannot resolve dependencies or manage installations or scopes in the runtime being closed.
  Run them with their closing owner as both the ambient scope and teardown context.
  All teardown errors are aggregated after cleanup continues.
- Check installation lifecycle guards on every `close()` call, including calls after close has settled.
  Keep close bookkeeping in the returned promise chain so ignored teardown failures remain unhandled rejections.
- Overrides create child scopes and never mutate existing scopes.
  An override runner is immutable: `extend()` returns a new runner, and every `run()` call re-invokes each layer's provision factory and enters one child scope per layer, outermost layer first.
  `wrap()` performs one `run()` per call of the returned function, forwards its arguments and receiver, and prepares nothing before it is called.
  A value override builds one provision per call from the options fixed when it was created, and rejects a dependency of another runtime when it is created rather than when it is called.
  Reject a provision list passed instead of a provision factory.
  Installed providers use the same immutable bindings, dependency tracking, ownership, and disposal rules as scoped overrides.
  `Runtime.dispose()` force-closes its complete scope tree.
  `retire()` waits for live descendants, while `close()` force-closes the subtree.
- Name the type parameter of a callback-based API `TCallbackResult` and infer it from the callback's own return type, whether or not the API awaits it.
  Declare an awaited result as `Promise<Awaited<TCallbackResult>>` instead of declaring the callback as returning `TCallbackResult | Promise<TCallbackResult>`, and do not export an alias for that form.
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
- `tests/runtime.test.ts` covers runtime APIs, installation semantics, isolation, and cross-runtime boundaries.
- `tests/resolution.test.ts` covers tracking, promotion, and resolution errors.
- `tests/scope-lifecycle.test.ts` covers scope creation, async context, ownership, disposal, retirement, close, and leaked scopes.
- `tests/overrides.test.ts` covers override runners, their layers, value overrides, and per-call isolation.
- `tests/model-based.test.ts` compares generated graphs with a deterministic reference resolver.
- `tests/awaitable.ts` provides the shared awaitable test double and holds no tests.
- `tests/smoke.mjs` exercises the built package through its public entry point on other runtimes, so it uses `node:assert` instead of `bun:test` and stays inside the language and library level supported by the oldest claimed Node version.

- Add a `describe` block where the file gives a reason for it: several APIs or behaviors in one file, or a fixture that belongs to some cases but not all.
  Name such a block after what it covers and keep its fixtures inside it.
- Use semantic names instead of ordinal placeholders such as `first` and `second`.
- Keep model seeds deterministic and include the seed in failure messages.

## Checks

- Run `bun test` for the directed and deterministic model-based suites.
- Run `bun types` to type-check production code and tests when public types change.
- Run `bun run build` for package export, declaration, publint, and arethetypeswrong validation.
- Run `bun smoke` after a build when the runtime surface or the claimed runtime support changes.
  CI repeats that smoke test on Bun, Node 18, Node 24, and Deno, and a release waits for it.
