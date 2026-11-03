import { describe, expect, it, spyOn } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { loadDocs, parsePage } from "../../src/docs/load"
import { createDocsIndex, docs, normalizeDocsPath, renderDocsPage } from "../../src/docs"

const pages = loadDocs()

describe("docs/load", () => {
  it("loads every docs page in sidebar order", () => {
    expect(pages.length).toBeGreaterThan(20)
    expect(pages[0]!.path).toBe("index")
    const paths = pages.map((p) => p.path)
    expect(paths).toContain("configuration/canette-yaml")
    expect(paths).toContain("configuration/templates")
    // configuration/meta.json lists canette-yaml before templates
    expect(paths.indexOf("configuration/canette-yaml")).toBeLessThan(paths.indexOf("configuration/templates"))
  })

  it("gives every page a title and strips MDX syntax", () => {
    for (const p of pages) {
      expect(p.title).not.toBe(p.path)
      expect(p.markdown).not.toMatch(/^import\s/m)
      expect(p.markdown).not.toContain("<Callout")
      expect(p.markdown).not.toContain("</Callout>")
      expect(p.markdown).not.toMatch(/\]\(\/docs\//)
    }
  })

  it("fails when the docs dir is missing or empty", () => {
    const errors = spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(() => loadDocs("/nonexistent/docs/dir")).toThrow("docs directory not found")
      const empty = mkdtempSync(join(tmpdir(), "canette-docs-"))
      try {
        expect(() => loadDocs(empty)).toThrow("no .mdx pages found")
      } finally {
        rmSync(empty, { recursive: true, force: true })
      }
    } finally {
      errors.mockRestore()
    }
  })

  it("converts callouts, frontmatter and links", () => {
    const page = parsePage(
      "x/y",
      [
        "---",
        "title: My page",
        "description: Something useful.",
        "---",
        'import { Callout } from "fumadocs-ui/components/callout"',
        "",
        '<Callout type="warn">',
        "  Careful with [volumes](/docs/configuration/volumes#pvc).",
        "",
        "  Second paragraph.",
        "</Callout>",
        "",
        '<Callout type="info">One-liner.</Callout>',
        "",
        "See [home](/docs) and [yaml](/docs/configuration/canette-yaml).",
        "",
        "```ts",
        'import { x } from "y"',
        "<Callout>not a callout</Callout>",
        "```",
      ].join("\n"),
    )
    expect(page.title).toBe("My page")
    expect(page.description).toBe("Something useful.")
    expect(page.markdown).toBe(
      [
        "> **Warning:** Careful with [volumes](configuration/volumes#pvc).",
        ">",
        "> Second paragraph.",
        "",
        "> **Note:** One-liner.",
        "",
        "See [home](index) and [yaml](configuration/canette-yaml).",
        "",
        "```ts",
        'import { x } from "y"',
        "<Callout>not a callout</Callout>",
        "```",
      ].join("\n"),
    )
  })
})

describe("docs index", () => {
  it("is built from the bundled pages", () => {
    expect(docs.isEmpty).toBe(false)
    expect(docs.list().length).toBe(pages.length)
  })

  it.each([
    ["volumes", "configuration/volumes"],
    ["persistent volume", "configuration/volumes"],
    ["magic link", "configuration/authentication"],
  ])("search %p ranks %p first", (query, path) => {
    expect(docs.search(query)[0]?.path).toBe(path)
  })

  it("finds the canette.yaml reference for healthcheck", () => {
    expect(docs.search("healthcheck", 3).map((h) => h.path)).toContain("configuration/canette-yaml")
  })

  it("returns snippets containing the query and respects limit", () => {
    const hits = docs.search("volumes", 2)
    expect(hits.length).toBe(2)
    expect(hits[0]!.snippet.toLowerCase()).toContain("volume")
  })

  it("returns nothing for empty or stopword-only queries", () => {
    expect(docs.search("")).toEqual([])
    expect(docs.search("how to")).toEqual([])
  })

  it.each([
    "configuration/canette-yaml",
    "/docs/configuration/canette-yaml",
    "configuration/canette-yaml.mdx",
    "configuration/canette-yaml#full-reference",
    "canette-docs://configuration/canette-yaml",
    "https://canette.dev/docs/configuration/canette-yaml",
  ])("finds the page for %p", (input) => {
    expect(docs.getPage(input)?.path).toBe("configuration/canette-yaml")
  })

  it("normalizes the root page", () => {
    expect(normalizeDocsPath("/docs")).toBe("index")
    expect(normalizeDocsPath("")).toBe("index")
  })

  it("suggests close matches for an unknown path", () => {
    expect(docs.getPage("configuration/canette")).toBeUndefined()
    expect(docs.suggest("configuration/canette")[0]).toBe("configuration/canette-yaml")
    expect(docs.suggest("volume")[0]).toBe("configuration/volumes")
  })

  it("renders a page with title and version header", () => {
    const text = renderDocsPage(docs.getPage("configuration/canette-yaml")!)
    expect(text).toStartWith("# canette.yaml\n")
    expect(text).toContain("Source: canette docs, version ")
    expect(text).toContain("`configuration/canette-yaml`")
  })

  it("handles an empty bundle", () => {
    const empty = createDocsIndex([])
    expect(empty.isEmpty).toBe(true)
    expect(empty.search("volumes")).toEqual([])
    expect(empty.list()).toEqual([])
  })
})
