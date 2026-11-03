// Reads the docs site's raw .mdx pages (apps/docs/content/docs) into plain
// markdown. Imported as a Bun macro (`with { type: "macro" }`), so it runs at
// bundle time and `bun build --compile` bakes the pages into the binary — the
// API image never needs fumadocs or the docs files at runtime.
//
// The docs only use frontmatter, markdown and fumadocs' <Callout>, so a small
// text transform is enough; no MDX compiler needed.

import { existsSync, readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"
import { load } from "js-yaml"

export interface DocsPage {
  /** Page path relative to the docs root, without extension, e.g. "configuration/canette-yaml". */
  path: string
  title: string
  description: string
  markdown: string
}

const DEFAULT_DOCS_DIR = join(import.meta.dir, "../../../docs/content/docs")

const CALLOUT_LABELS: Record<string, string> = {
  info: "Note",
  warn: "Warning",
  warning: "Warning",
  error: "Important",
}

/**
 * Throws when the docs are missing, so a build without them fails instead of
 * silently shipping a binary whose docs tools only return errors. In Docker,
 * apps/docs/content must be copied into the build stage.
 */
export function loadDocs(dir: string = DEFAULT_DOCS_DIR): DocsPage[] {
  if (!existsSync(dir)) fail(`docs directory not found: ${dir}`)
  const pages: DocsPage[] = []
  for (const rel of orderedPages(dir, "")) {
    pages.push(parsePage(rel, readFileSync(join(dir, `${rel}.mdx`), "utf8")))
  }
  if (pages.length === 0) fail(`no .mdx pages found in ${dir}`)
  return pages
}

function fail(reason: string): never {
  const message = `Cannot bundle the canette docs for the MCP server: ${reason}. Copy apps/docs/content into the build (see apps/api/Dockerfile).`
  // Bun replaces an error thrown inside a macro with a generic "cannot coerce
  // Exception" message, so print the real reason first.
  console.error(message)
  throw new Error(message)
}

/** Page paths in sidebar order (meta.json `pages`), then anything meta.json doesn't list. */
function orderedPages(root: string, rel: string): string[] {
  const dir = join(root, rel)
  const entries = readdirSync(dir)
  const names = new Set(
    entries
      .filter((e) => e.endsWith(".mdx") || statSync(join(dir, e)).isDirectory())
      .map((e) => e.replace(/\.mdx$/, "")),
  )

  const order: string[] = []
  const metaPath = join(dir, "meta.json")
  if (existsSync(metaPath)) {
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as { pages?: unknown }
    if (Array.isArray(meta.pages)) {
      for (const p of meta.pages) if (typeof p === "string" && names.has(p)) order.push(p)
    }
  }
  for (const n of [...names].sort()) if (!order.includes(n)) order.push(n)

  const out: string[] = []
  for (const name of order) {
    const child = rel ? `${rel}/${name}` : name
    if (existsSync(join(root, `${child}.mdx`))) out.push(child)
    if (existsSync(join(root, child)) && statSync(join(root, child)).isDirectory()) {
      out.push(...orderedPages(root, child))
    }
  }
  return out
}

export function parsePage(path: string, source: string): DocsPage {
  let body = source
  let title = path
  let description = ""

  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(body)
  if (fm) {
    const data = (load(fm[1]!) ?? {}) as Record<string, unknown>
    if (typeof data.title === "string") title = data.title
    if (typeof data.description === "string") description = data.description
    body = body.slice(fm[0].length)
  }

  return { path, title, description, markdown: transformBody(body).trim() }
}

/** Strip MDX imports/exports, turn <Callout> into blockquotes, rewrite /docs links — outside code fences only. */
function transformBody(body: string): string {
  const out: string[] = []
  let inFence = false
  let callout: { label: string; lines: string[] } | null = null

  for (const line of body.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence

    if (!inFence && !callout && /^(import|export)\s/.test(line)) continue

    if (!inFence) {
      const open = /^\s*<Callout(?:\s+type="([a-z]+)")?[^>]*>(.*)$/.exec(line)
      if (open && !callout) {
        callout = { label: CALLOUT_LABELS[open[1] ?? "info"] ?? "Note", lines: [] }
        const rest = open[2]!
        const close = rest.indexOf("</Callout>")
        if (close === -1) {
          if (rest.trim()) callout.lines.push(rest)
          continue
        }
        callout.lines.push(rest.slice(0, close))
        out.push(...renderCallout(callout))
        callout = null
        continue
      }
      if (callout) {
        const close = line.indexOf("</Callout>")
        if (close === -1) {
          callout.lines.push(line)
          continue
        }
        if (line.slice(0, close).trim()) callout.lines.push(line.slice(0, close))
        out.push(...renderCallout(callout))
        callout = null
        continue
      }
      out.push(rewriteLinks(line))
      continue
    }

    if (callout) callout.lines.push(line)
    else out.push(line)
  }
  if (callout) out.push(...renderCallout(callout))
  return out.join("\n")
}

function renderCallout({ label, lines }: { label: string; lines: string[] }): string[] {
  // Dedent by the smallest indent so nested code blocks keep their shape.
  const indents = lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length)
  const min = indents.length ? Math.min(...indents) : 0
  const body = lines.map((l) => rewriteLinks(l.slice(min)))
  while (body.length && !body[0]!.trim()) body.shift()
  while (body.length && !body[body.length - 1]!.trim()) body.pop()
  const quoted = body.map((l) => (l.trim() ? `> ${l}` : ">"))
  if (quoted.length) quoted[0] = `> **${label}:** ${quoted[0]!.slice(2)}`
  else quoted.push(`> **${label}**`)
  return quoted
}

/** `](/docs/configuration/volumes#x)` → `](configuration/volumes#x)`, matching get_docs_page paths. */
function rewriteLinks(line: string): string {
  return line.replace(/\]\(\/docs\/?([^)\s]*)\)/g, (_m, p: string) => `](${p || "index"})`)
}
