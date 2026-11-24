import { describe, expect, it } from "bun:test"
import { Hono } from "hono"
import {
  DEFAULT_BODY_LIMIT,
  LARGE_BODY_LIMIT,
  limitBody,
  requestBodyLimit,
} from "../../src/middleware/body-limit"

const app = new Hono()
  .use("*", requestBodyLimit())
  .post("*", async (c) => c.json({ read: (await c.req.arrayBuffer()).byteLength }))

// A chunked body: no Content-Length, so the limit has to count while reading.
function chunked(size: number, chunkSize = 64 * 1024): ReadableStream<Uint8Array> {
  let sent = 0
  return new ReadableStream({
    pull(controller) {
      if (sent >= size) return controller.close()
      const n = Math.min(chunkSize, size - sent)
      sent += n
      controller.enqueue(new Uint8Array(n))
    },
  })
}

function post(path: string, size: number, { stream = false } = {}) {
  return app.request(path, {
    method: "POST",
    body: stream ? chunked(size) : new Uint8Array(size),
    ...(stream ? { duplex: "half", headers: { "transfer-encoding": "chunked" } } : {}),
  } as RequestInit)
}

describe("middleware/body-limit", () => {
  for (const stream of [false, true]) {
    const kind = stream ? "chunked" : "declared"

    it(`accepts a ${kind} body at the default limit and rejects one just over it`, async () => {
      expect((await post("/api/v1/projects", DEFAULT_BODY_LIMIT, { stream })).status).toBe(200)

      const res = await post("/api/v1/projects", DEFAULT_BODY_LIMIT + 1, { stream })
      expect(res.status).toBe(413)
      expect(await res.json()).toEqual({ error: "Request body exceeds the 1 MiB limit", code: "PAYLOAD_TOO_LARGE" })
    })

    it(`applies the large limit to volume and MCP routes (${kind})`, async () => {
      for (const path of ["/api/v1/apps/abc/volumes", "/api/v1/apps/abc/volumes/vol-1", "/mcp"]) {
        expect((await post(path, DEFAULT_BODY_LIMIT + 1, { stream })).status).toBe(200)
        expect((await post(path, LARGE_BODY_LIMIT + 1, { stream })).status).toBe(413)
      }
    })
  }

  it("keeps the default limit for public auth and OAuth routes", async () => {
    for (const path of ["/oauth/register", "/oauth/token", "/api/auth/sign-up/email", "/api/v1/apps/abc/volumes-x"]) {
      expect((await post(path, DEFAULT_BODY_LIMIT + 1)).status).toBe(413)
    }
  })

  it("leaves webhook receivers to their own router", async () => {
    expect((await post("/api/v1/webhooks/app/abc", DEFAULT_BODY_LIMIT + 1)).status).toBe(200)
  })

  it("passes the body through unchanged after counting a chunked one", async () => {
    const small = new Hono().use("*", limitBody(1024)).post("/", async (c) => c.text(await c.req.text()))
    const res = await small.request("/", {
      method: "POST",
      body: new Blob(["hello ", "world"]).stream(),
      duplex: "half",
      headers: { "transfer-encoding": "chunked" },
    } as RequestInit)
    expect(await res.text()).toBe("hello world")
  })
})
