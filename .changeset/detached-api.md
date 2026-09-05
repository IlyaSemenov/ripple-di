---
"ripple-di": major
---

Rename `withDetachedContext` to `runDetached` and remove `withDetachedOverrides`.
Add `createDetachedStream`, which opens an async source that keeps the current dependency context for every read.
