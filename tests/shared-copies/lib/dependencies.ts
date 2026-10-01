import { defineDependency, MissingProviderError } from "ripple-di"

export const useLibraryValue = defineDependency(() => 1)
export const libraryError = new MissingProviderError("library", [])
