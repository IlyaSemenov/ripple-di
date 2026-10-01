// Values of another installation of the same version share public types.
import {
  type Dependency,
  type MissingProviderError,
  type Provision,
  provide,
  resolve,
} from "ripple-di"

import { libraryError, useLibraryValue } from "./lib/dependencies"

export const dependency: Dependency<number> = useLibraryValue
export const value: number = resolve(useLibraryValue)
export const provision: Provision = provide(useLibraryValue, value)
export const error: MissingProviderError = libraryError
