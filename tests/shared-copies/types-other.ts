// Values of an installation of another version keep incompatible types.
import { provide } from "ripple-di"

import { useLibraryValue } from "./other/dependencies"

export const provision = provide(useLibraryValue, 1)
