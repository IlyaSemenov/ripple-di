// A module of an installation with a different ripple-di version.
import * as ripple from "ripple-di"

export { ripple }

export const copyUrl = import.meta.resolve("ripple-di")
export const useBase = ripple.defineDependency(() => 1, { name: "base" })
