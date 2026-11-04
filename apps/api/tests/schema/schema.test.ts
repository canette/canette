// The template JSON Schema is generated from Go types (tools/canette-schema),
// but templates are parsed here in TypeScript. These checks catch a field
// added on one side only.

import { describe, expect, it } from "bun:test"
import { getSchema } from "../../src/docs/schemas"
import { APP_ROW_FIELDS } from "../../src/services/templates"

interface SchemaNode {
  properties?: Record<string, SchemaNode>
  items?: SchemaNode
  required?: string[]
}

const canette = JSON.parse(getSchema("canette.json")) as SchemaNode
const template = JSON.parse(getSchema("canette-template.json")) as SchemaNode
const templateApp = template.properties!.apps!.items!

describe("canette-template.yaml schema", () => {
  it("describes every app field the template parser reads", () => {
    const props = Object.keys(templateApp.properties!)
    for (const field of APP_ROW_FIELDS) expect(props).toContain(field)
  })

  it("describes no app field the template parser has stopped reading", () => {
    // Every other field must be a canette.yaml field, which the parser passes through as canetteConfig.
    const known = new Set([...APP_ROW_FIELDS, ...Object.keys(canette.properties!)])
    const stale = Object.keys(templateApp.properties!).filter((p) => !known.has(p))
    expect(stale).toEqual([])
  })

  it("accepts every canette.yaml field on a template app", () => {
    const props = Object.keys(templateApp.properties!)
    for (const field of Object.keys(canette.properties!)) expect(props).toContain(field)
  })

  it("requires the same fields the parser requires", () => {
    expect(template.required).toEqual(["name", "apps"])
    expect(templateApp.required).toEqual(["name", "slug"])
  })
})
