import { describe, expect, it } from "bun:test"
import { validateCanetteConfigYaml } from "../../src/services/canette-config"
import { ServiceError } from "../../src/services/errors"

describe("services/canette-config validateCanetteConfigYaml", () => {
  it("accepts a mapping, an empty document and comments only", () => {
    expect(() => validateCanetteConfigYaml("replicas: 2\nruntime:\n  port: 8080\n")).not.toThrow()
    expect(() => validateCanetteConfigYaml("")).not.toThrow()
    expect(() => validateCanetteConfigYaml("# nothing yet\n")).not.toThrow()
  })

  it("accepts unknown fields", () => {
    expect(() => validateCanetteConfigYaml("future_field:\n  enabled: true\n")).not.toThrow()
  })

  it("reports a syntax error on one line with its position", () => {
    try {
      validateCanetteConfigYaml("replicas: 1\nresources:\n  limits: {cpu: 1\n")
      throw new Error("expected a ServiceError")
    } catch (e) {
      expect(e).toBeInstanceOf(ServiceError)
      const message = (e as ServiceError).message
      expect(message).toMatch(/^canetteConfig is not valid YAML: .+ \(line \d+, column \d+\)$/)
      expect(message).not.toContain("\n")
    }
  })

  it("rejects a document that is not a mapping", () => {
    expect(() => validateCanetteConfigYaml("- a\n- b\n")).toThrow(/YAML mapping/)
    expect(() => validateCanetteConfigYaml("just a string")).toThrow(/YAML mapping/)
  })
})
