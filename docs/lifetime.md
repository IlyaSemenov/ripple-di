# Value Lifetime

Ripple DI cleans up a value it created when the scope that owns the value closes.
A value belongs to the innermost scope that provided either its factory or one of the dependencies the factory called.
When all of them come from the application, the value belongs to the application and lives until [shutdown](./application#shut-down).

## Give each operation its own value

For a value that belongs to one operation, such as a request transaction, define the dependency without a factory, and provide the factory when the operation starts:

```ts
const useTransaction = defineDependency<Transaction>({
  dispose: tx => tx.rollback(),
})

await withOverrides(
  provideFactory(useTransaction, () => useDb().transaction()),
  () => processRequest(),
)
```

Each request gets its own transaction, created on first use and rolled back when the callback finishes.
Outside such a scope, `useTransaction()` throws `MissingProviderError` instead of sharing one transaction.

Calling a dependency inside a scope does not make its value scope-local, so a built-in factory does not work here:

```ts
// Wrong: every request shares one transaction.
const useTransaction = defineDependency(() => useDb().transaction(), {
  dispose: tx => tx.rollback(),
})
```

`useDb` belongs to the application, so the transaction built from it belongs to the application too.
Every request reads the same transaction, and it is rolled back at shutdown rather than when the request ends.

A value does become scope-local when its factory calls a dependency that the scope provides, such as a request context, a tenant, or a fixed clock.
It is then built again in that scope and cleaned up with it.

## Hand a provided value over

A value passed to `provide` stays yours: Ripple DI uses it but never cleans it up, even when the dependency has `dispose` or the value implements `Symbol.dispose`.
Pass `dispose` to hand the value over to the scope:

```ts
// You clean up testConfig yourself.
provide(useConfig, testConfig)

// The scope cleans up fakeDb with the dependency's own dispose.
provide(useDb, fakeDb, { dispose: true })

// The scope cleans up fakeDb with this callback instead.
provide(useDb, fakeDb, { dispose: db => db.closeImmediately() })

// The scope creates the value on first use and cleans it up with the dependency's own dispose.
provideFactory(useDb, () => createFakeDb())
```

A handed-over value belongs to exactly one scope or installation, so create a new value and provision for each of them.
