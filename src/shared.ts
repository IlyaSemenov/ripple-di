// Opt-in entry: load it before any copy of the main entry so that every
// same-version copy loaded afterward uses this copy's implementation.
import * as implementation from "./api"
import { shareImplementation } from "./sharing"

shareImplementation(implementation)
