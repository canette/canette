import { afterEach, describe, expect, it } from "bun:test"
import { userCanAccessInstallation } from "../../src/services/github-app-token"

const realFetch = globalThis.fetch

// Serves ids 1..total, 100 per page, and records the pages requested.
function stubInstallations(total: number): number[] {
  const pages: number[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    const page = Number(new URL(String(input)).searchParams.get("page"))
    pages.push(page)
    const ids = Array.from({ length: total }, (_, i) => i + 1).slice((page - 1) * 100, page * 100)
    return Response.json({ total_count: total, installations: ids.map((id) => ({ id })) })
  }) as typeof fetch
  return pages
}

describe("services/github-app-token", () => {
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  describe("userCanAccessInstallation", () => {
    it("finds an installation on a later page", async () => {
      const pages = stubInstallations(250)
      expect(await userCanAccessInstallation("ghu_x", "230")).toBe(true)
      expect(pages).toEqual([1, 2, 3])
    })

    it("stops after the last page when the installation is missing", async () => {
      const pages = stubInstallations(150)
      expect(await userCanAccessInstallation("ghu_x", "999")).toBe(false)
      expect(pages).toEqual([1, 2])
    })

    it("throws when GitHub rejects the user token", async () => {
      globalThis.fetch = (async () => new Response("Bad credentials", { status: 401 })) as unknown as typeof fetch
      await expect(userCanAccessInstallation("ghu_x", "1")).rejects.toThrow("401")
    })
  })
})
