import { describe, it, expect } from "vitest"
import { parseTemplate } from "../../src/services/templates"

const VALID_TEMPLATE = `
name: "Full-stack starter"
description: "API + Postgres"
apps:
  - name: API
    slug: api
    source_type: git
    git_url: https://github.com/org/api
    git_branch: main
    port: 3000
    env:
      DB_HOST: "{{apps.db.slug}}"
    secrets:
      - DB_PASSWORD
    resources:
      requests:
        cpu: 100m

  - name: Database
    slug: db
    source_type: image
    image_url: postgres
    image_tag: "16"
    port: 5432
`

describe("services/templates — parseTemplate", () => {
  it("parses a valid two-app template", async () => {
    const result = await parseTemplate({ yaml: VALID_TEMPLATE })

    expect(result.name).toBe("Full-stack starter")
    expect(result.description).toBe("API + Postgres")
    expect(result.apps).toHaveLength(2)

    const [api, db] = result.apps
    expect(api.name).toBe("API")
    expect(api.slug).toBe("api")
    expect(api.sourceType).toBe("git")
    expect(api.gitUrl).toBe("https://github.com/org/api")
    expect(api.gitBranch).toBe("main")
    expect(api.port).toBe(3000)
    expect(api.env).toEqual({ DB_HOST: "{{apps.db.slug}}" })
    expect(api.secrets).toEqual([{ name: "DB_PASSWORD" }])
    // resources go into canetteConfig
    expect(api.canetteConfig).toContain("cpu: 100m")

    expect(db.name).toBe("Database")
    expect(db.slug).toBe("db")
    expect(db.sourceType).toBe("image")
    expect(db.imageUrl).toBe("postgres")
    expect(db.imageTag).toBe("16")
    expect(db.canetteConfig).toBeUndefined()
  })

  it("silently ignores unknown top-level fields", async () => {
    const yaml = `
name: test
unknown_future_field: ignored
apps:
  - name: App
    slug: app
    source_type: git
    git_url: https://github.com/org/repo
`
    const result = await parseTemplate({ yaml })
    expect(result.apps).toHaveLength(1)
  })

  it("silently ignores unknown app-level fields via canetteConfig passthrough", async () => {
    const yaml = `
name: test
apps:
  - name: App
    slug: app
    source_type: git
    git_url: https://github.com/org/repo
    some_future_field: value
`
    const result = await parseTemplate({ yaml })
    expect(result.apps[0].canetteConfig).toContain("some_future_field")
  })

  it("defaults source_type to git when omitted", async () => {
    const yaml = `
name: test
apps:
  - name: App
    slug: app
    git_url: https://github.com/org/repo
`
    const result = await parseTemplate({ yaml })
    expect(result.apps[0].sourceType).toBe("git")
  })

  it("rejects missing template name", async () => {
    const yaml = `
apps:
  - name: App
    slug: app
    source_type: git
    git_url: https://github.com/org/repo
`
    await expect(parseTemplate({ yaml })).rejects.toMatchObject({
      code: "INVALID_TEMPLATE",
    })
  })

  it("rejects empty apps array", async () => {
    const yaml = `name: test\napps: []`
    await expect(parseTemplate({ yaml })).rejects.toMatchObject({
      code: "INVALID_TEMPLATE",
    })
  })

  it("rejects app with missing slug", async () => {
    const yaml = `
name: test
apps:
  - name: App
    source_type: git
`
    await expect(parseTemplate({ yaml })).rejects.toMatchObject({
      code: "INVALID_TEMPLATE",
    })
  })

  it("rejects app with invalid slug format", async () => {
    const yaml = `
name: test
apps:
  - name: App
    slug: Bad_Slug!
    source_type: git
`
    await expect(parseTemplate({ yaml })).rejects.toMatchObject({
      code: "INVALID_TEMPLATE",
    })
  })

  it("rejects duplicate slugs within a template", async () => {
    const yaml = `
name: test
apps:
  - name: App 1
    slug: app
    source_type: git
  - name: App 2
    slug: app
    source_type: image
    image_url: nginx
`
    await expect(parseTemplate({ yaml })).rejects.toMatchObject({
      code: "INVALID_TEMPLATE",
    })
  })

  it("rejects invalid YAML", async () => {
    await expect(parseTemplate({ yaml: ": : : bad yaml !!!" })).rejects.toMatchObject({
      code: "INVALID_YAML",
    })
  })

  it("rejects empty yaml", async () => {
    await expect(parseTemplate({ yaml: "" })).rejects.toMatchObject({
      code: "INVALID_TEMPLATE",
    })
  })
})
