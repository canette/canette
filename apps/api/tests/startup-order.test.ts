import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "fs"
import { dirname, resolve } from "path"

// better-auth validates (and caches) the database schema the moment
// `betterAuth()` is constructed. If src/auth/auth.ts is loaded before
// migrations have run, a fresh install fails every auth request with
// "Missing tables: user, session, account, verification". src/index.ts
// therefore must not statically import anything that reaches auth.ts —
// only dynamic `await import()` after runMigrations().

const SRC = resolve(import.meta.dir, "../src")
const ENTRY = resolve(SRC, "index.ts")
const AUTH = resolve(SRC, "auth/auth.ts")

const transpiler = new Bun.Transpiler({ loader: "ts" })

function resolveLocal(from: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null
  const base = resolve(dirname(from), spec)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")]) {
    if (candidate.endsWith(".ts") || candidate.endsWith(".tsx")) {
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** Files reachable from `entry` through static (non-type-only) imports. */
function staticImportGraph(entry: string): Map<string, string | null> {
  const parents = new Map<string, string | null>([[entry, null]])
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.shift()!
    // scanImports drops type-only imports, which have no runtime effect.
    const imports = transpiler.scanImports(readFileSync(file, "utf8"))
    for (const imp of imports) {
      if (imp.kind !== "import-statement") continue
      const target = resolveLocal(file, imp.path)
      if (target && !parents.has(target)) {
        parents.set(target, file)
        queue.push(target)
      }
    }
  }
  return parents
}

describe("API startup order", () => {
  test("src/index.ts does not statically load auth.ts before migrations run", () => {
    const graph = staticImportGraph(ENTRY)
    if (graph.has(AUTH)) {
      const chain: string[] = []
      for (let f: string | null = AUTH; f; f = graph.get(f) ?? null) chain.unshift(f.replace(`${SRC}/`, ""))
      throw new Error(`auth.ts is statically imported before migrations: ${chain.join(" -> ")}`)
    }
    expect(graph.has(AUTH)).toBe(false)
  })

  test("the import-graph check would catch a static import of the app", () => {
    // Guards the guard: app.ts statically reaches auth.ts.
    expect(staticImportGraph(resolve(SRC, "app.ts")).has(AUTH)).toBe(true)
  })
})
