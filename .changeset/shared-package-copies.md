---
"ripple-di": minor
---

Add the `ripple-di/shared` entry: loading it before other copies of the same exact version lets separately installed or bundled copies share one implementation, including dependencies, scopes, installation, shutdown, and error classes.
Copies of another version throw during import instead of starting a separate graph.
