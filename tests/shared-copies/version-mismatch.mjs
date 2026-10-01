// A copy of another version cannot join the shared implementation.
import "ripple-di/shared"

import assert from "node:assert/strict"

import { useBase } from "./lib/index.mjs"

const mismatch = {
  message:
    /^ripple-di 0\.0\.0-other cannot join the shared implementation registered by ripple-di \d+\.\d+\.\d+\S*\. Every copy loaded after "ripple-di\/shared" must have exactly the same version\.$/,
}
await assert.rejects(import("./other/index.mjs"), mismatch)
await assert.rejects(import("./other/shared.mjs"), mismatch)
assert.equal(useBase(), 1)
