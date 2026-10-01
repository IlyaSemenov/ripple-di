import { expect, it } from "bun:test"

import * as api from "./api"
import * as index from "./index"

it("exports every value of the package implementation", () => {
  expect(Object.keys(index)).toEqual(Object.keys(api))
})
