// Version-matched canette docs for the MCP server: keyword search over page
// sections and page lookup by path. The pages are inlined at bundle time by
// the loadDocs macro, so a compiled API binary carries the docs of the exact
// release it was built from.

import { loadDocs } from "./load" with { type: "macro" }
import type { DocsPage } from "./load"

export type { DocsPage }

export interface DocsSearchHit {
  path: string
  title: string
  heading: string | null
  snippet: string
}

export interface DocsPageSummary {
  path: string
  title: string
  description: string
}

interface Section {
  page: DocsPage
  heading: string | null
  text: string
  lowerHeading: string
  lowerText: string
}

const STOPWORDS = new Set([
  "a", "an", "and", "are", "can", "do", "does", "for", "how", "i", "in", "is", "it",
  "of", "on", "or", "the", "to", "what", "with", "my", "use", "using",
])

const SNIPPET_LENGTH = 200

export const DOCS_VERSION = process.env.APP_VERSION ?? "development"

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .map((t) => t.replace(/^[.-]+|[.-]+$/g, ""))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

function countOccurrences(haystack: string, needle: string): number {
  let n = 0
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++
  return n
}

/** Split a page into sections on ## / ### headings (outside code fences). */
function splitSections(page: DocsPage): Section[] {
  const sections: Section[] = []
  let heading: string | null = null
  let lines: string[] = []
  let inFence = false

  const flush = () => {
    const text = lines.join("\n").trim()
    if (text || heading) {
      sections.push({ page, heading, text, lowerHeading: (heading ?? "").toLowerCase(), lowerText: text.toLowerCase() })
    }
  }

  for (const line of page.markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    const h = !inFence && /^#{2,3}\s+(.+?)\s*#*\s*$/.exec(line)
    if (h) {
      flush()
      heading = h[1]!
      lines = []
    } else {
      lines.push(line)
    }
  }
  flush()
  return sections
}

function makeSnippet(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, " ").trim()
  const lower = flat.toLowerCase()
  let at = -1
  for (const t of terms) {
    const i = lower.indexOf(t)
    if (i !== -1 && (at === -1 || i < at)) at = i
  }
  const start = Math.max(0, (at === -1 ? 0 : at) - 60)
  const end = Math.min(flat.length, start + SNIPPET_LENGTH)
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = tmp
    }
  }
  return prev[b.length]!
}

/** Accepts "configuration/canette-yaml", "/docs/configuration/canette-yaml.mdx#x", "canette-docs://…" etc. */
export function normalizeDocsPath(input: string): string {
  let p = input.trim()
  p = p.replace(/^canette-docs:\/\//, "")
  p = p.replace(/^https?:\/\/[^/]+/, "")
  p = p.replace(/[#?].*$/, "")
  p = p.replace(/^\/+/, "").replace(/\/+$/, "")
  p = p.replace(/^docs(\/|$)/, "")
  p = p.replace(/\.(mdx?|html)$/, "")
  p = p.replace(/\/index$/, "")
  return p.toLowerCase() || "index"
}

export function createDocsIndex(pages: DocsPage[]) {
  const byPath = new Map(pages.map((p) => [p.path, p]))
  const sections = pages.flatMap(splitSections)

  function search(query: string, limit = 5): DocsSearchHit[] {
    const terms = [...new Set(tokenize(query))]
    if (terms.length === 0) return []
    const phrase = query.trim().toLowerCase()

    const scored: { section: Section; score: number }[] = []
    for (const section of sections) {
      const lowerTitle = section.page.title.toLowerCase()
      const lowerPath = section.page.path.toLowerCase()
      let score = 0
      let matched = 0
      for (const t of terms) {
        const body = Math.min(countOccurrences(section.lowerText, t), 10)
        const inHeading = section.lowerHeading.includes(t) ? 3 : 0
        const inTitle = lowerTitle.includes(t) || lowerPath.includes(t) ? 5 : 0
        if (body || inHeading || inTitle) matched++
        score += body + inHeading + inTitle
      }
      if (score === 0) continue
      // Prefer sections that match every term, then exact phrase matches.
      score *= matched / terms.length
      if (terms.length > 1 && (section.lowerText.includes(phrase) || section.lowerHeading.includes(phrase))) score += 5
      scored.push({ section, score })
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit).map(({ section }) => ({
      path: section.page.path,
      title: section.page.title,
      heading: section.heading,
      snippet: makeSnippet(section.text || section.heading || "", terms),
    }))
  }

  function getPage(path: string): DocsPage | undefined {
    return byPath.get(normalizeDocsPath(path))
  }

  /** Closest page paths to an unknown path, best first. */
  function suggest(path: string, limit = 5): string[] {
    const wanted = normalizeDocsPath(path)
    const wantedLast = wanted.split("/").pop()!
    const wantedTokens = new Set(tokenize(wanted.replace(/\//g, " ")))
    return pages
      .map((p) => {
        const last = p.path.split("/").pop()!
        const shared = tokenize(p.path.replace(/\//g, " ")).filter((t) => wantedTokens.has(t)).length
        const substring = p.path.includes(wanted) || wanted.includes(last) ? 1 : 0
        return { path: p.path, shared, substring, distance: levenshtein(wantedLast, last) }
      })
      .sort((a, b) => b.substring - a.substring || b.shared - a.shared || a.distance - b.distance)
      .slice(0, limit)
      .map((s) => s.path)
  }

  function list(): DocsPageSummary[] {
    return pages.map(({ path, title, description }) => ({ path, title, description }))
  }

  return { isEmpty: pages.length === 0, search, getPage, suggest, list }
}

export type DocsIndex = ReturnType<typeof createDocsIndex>

export const docs: DocsIndex = createDocsIndex(loadDocs())

/** A page rendered for an MCP client: title header, version line, then the markdown. */
export function renderDocsPage(page: DocsPage): string {
  const desc = page.description ? `\n\n${page.description}` : ""
  return `# ${page.title}\n\nSource: canette docs, version ${DOCS_VERSION}, page \`${page.path}\`${desc}\n\n${page.markdown}\n`
}
