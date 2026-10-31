# Several Package Copies

Each copy of Ripple DI in a process, whether installed separately or bundled, runs its own graph.
Declare `ripple-di` as a peer dependency in any package that exports dependencies, so that the application installs one copy.

Do not pass dependencies or provisions between copies, and do not call a dependency of one copy inside a factory of another.
Such a call is not detected: the dependency resolves in its own copy instead of failing.

## Share one implementation between copies

When one process has to run code that imports different copies of the same Ripple DI version, such as packages with separate installations or a bundle that inlines Ripple DI next to an installed copy, load `ripple-di/shared` before any module that imports `ripple-di`.
Preload it when the process starts:

```sh
node --import ripple-di/shared server.mjs
bun --preload ripple-di/shared server.ts
```

Or make it the first import of the entry module, since static imports are evaluated in order:

```ts
// server.ts
import "ripple-di/shared"

import { startServer } from "./app"
```

Every copy loaded afterward uses the implementation of the copy that loaded `ripple-di/shared`, while application code keeps importing from `ripple-di`.
Dependencies, provisions, scopes, installations, memos, and shutdown then work across copies as if there were one, and `instanceof` recognizes errors from any of them.

- Only copies of exactly the same version can share an implementation; loading a copy of another version afterward throws during import.
- A copy loaded before `ripple-di/shared` keeps its own implementation, and the shared copies reject its dependencies and provisions.
- Each worker thread and process loads `ripple-di/shared` for its own copies.
- `createRuntime()` still creates an independent runtime, whichever copy it comes from.

Sharing Ripple DI does not share other packages.
A database client or connection pool installed twice still runs as two copies, and objects created by one copy may fail identity checks in the other.
Make such packages resolve to one installation, or create one instance and provide it through a dependency.
