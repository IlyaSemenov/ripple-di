// A module of a separate installation that resolves its own ripple-di copy.
import * as ripple from "ripple-di"

export { ripple }

export const copyUrl = import.meta.resolve("ripple-di")
export const useBase = ripple.defineDependency(() => 1, { name: "base" })
