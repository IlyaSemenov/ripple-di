import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import {
  cp,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { build } from "tsdown"

// Every scenario runs in a fresh process: sharing is permanent for a realm and
// depends on the order in which copies are evaluated.
// The workspace holds physical package copies built from the current sources:
// the application copy in `node_modules`, a same-version copy in
// `lib/node_modules`, and a copy of another version in `other/node_modules`.

const repository = join(import.meta.dir, "..")
const fixtures = join(import.meta.dir, "shared-copies")
const manifest = JSON.parse(
  await readFile(join(repository, "package.json"), "utf8"),
)
const otherVersion = "0.0.0-other"
const node = Bun.which("node") ?? "node"
const runtimes = [
  { name: "Bun", command: process.execPath, preload: "--preload" },
  { name: "Node", command: node, preload: "--import" },
]

let workspace: string
let sourceTrees: string

// The build inlines the version from the manifest, so every package version is
// built from its own source tree.
async function buildPackage(version: string): Promise<string> {
  const sources = join(sourceTrees, version)
  await cp(join(repository, "src"), join(sources, "src"), { recursive: true })
  await cp(join(repository, "tsconfig.json"), join(sources, "tsconfig.json"))
  await symlink(join(repository, "node_modules"), join(sources, "node_modules"))
  await writeFile(
    join(sources, "package.json"),
    JSON.stringify({ ...manifest, version }),
  )
  await build({
    config: false,
    cwd: sources,
    entry: ["src/index.ts", "src/shared.ts"],
    format: "esm",
    dts: true,
    outDir: join(sources, "dist"),
    logLevel: "silent",
  })
  return sources
}

async function installCopy(sources: string, directory: string) {
  const target = join(workspace, directory, "node_modules", "ripple-di")
  await cp(join(sources, "dist"), join(target, "dist"), { recursive: true })
  await cp(join(sources, "package.json"), join(target, "package.json"))
}

function run(...command: string[]) {
  const result = Bun.spawnSync(command, {
    cwd: workspace,
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  }
}

const success = { exitCode: 0, stdout: "", stderr: "" }

beforeAll(async () => {
  // The type emitter misses entries reached through a symlinked temp directory.
  workspace = await realpath(await mkdtemp(join(tmpdir(), "ripple-di-copies-")))
  // Bun caches resolution while building, so source trees stay outside the
  // workspace whose node_modules are installed afterward.
  sourceTrees = await realpath(
    await mkdtemp(join(tmpdir(), "ripple-di-sources-")),
  )
  await cp(fixtures, workspace, { recursive: true })
  const current = await buildPackage(manifest.version)
  const other = await buildPackage(otherVersion)
  await installCopy(current, ".")
  await installCopy(current, "lib")
  await installCopy(other, "other")
})

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true })
  await rm(sourceTrees, { recursive: true, force: true })
})

for (const runtime of runtimes) {
  describe(`separately installed copies on ${runtime.name}`, () => {
    it("share one implementation after the opt-in entry", () => {
      expect(run(runtime.command, "shared.mjs")).toEqual(success)
    })

    it("stay independent without the opt-in entry", () => {
      expect(run(runtime.command, "independent.mjs")).toEqual(success)
    })

    it("keep a copy evaluated before the opt-in entry independent", () => {
      expect(run(runtime.command, "late-opt-in.mjs")).toEqual(success)
    })

    it("reject a copy of another version", () => {
      expect(run(runtime.command, "version-mismatch.mjs")).toEqual(success)
    })
  })
}

describe("bundled and external copies", () => {
  beforeAll(async () => {
    const result = await Bun.build({
      entrypoints: [
        join(workspace, "bundle-opt-in.mjs"),
        join(workspace, "bundle-joins.mjs"),
      ],
      outdir: workspace,
      naming: "[name].bundle.mjs",
      target: "node",
      format: "esm",
    })
    expect(result.logs).toEqual([])
    for (const name of ["bundle-opt-in", "bundle-joins"]) {
      const bundle = await readFile(
        join(workspace, `${name}.bundle.mjs`),
        "utf8",
      )
      // The bundled copy must be inlined rather than loaded from node_modules.
      expect(bundle).not.toMatch(/from\s*["']ripple-di/)
    }
  })

  for (const runtime of runtimes) {
    it(`keeps the bundled opt-in entry on ${runtime.name}`, () => {
      expect(run(runtime.command, "bundle-opt-in.bundle.mjs")).toEqual(success)
    })

    it(`joins an external copy preloaded on ${runtime.name}`, () => {
      expect(
        run(
          runtime.command,
          runtime.preload,
          "./lib/shared.mjs",
          "bundle-joins.bundle.mjs",
        ),
      ).toEqual(success)
    })
  }
})

describe("public types of separately installed copies", () => {
  const tsc = join(repository, "node_modules", ".bin", "tsc")

  it("are compatible for the same version", () => {
    expect(run(tsc, "-p", "tsconfig.same.json")).toEqual(success)
  })

  it("are incompatible for different versions", () => {
    const result = run(tsc, "-p", "tsconfig.other.json")
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain("types-other.ts")
    expect(result.stdout).toContain("TS2345")
  })
})
