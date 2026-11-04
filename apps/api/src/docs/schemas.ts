// JSON Schemas for canette.yaml and canette-template.yaml, inlined at bundle
// time by the loadSchemas macro so they match the instance's version.

import { loadSchemas } from "./load-schemas" with { type: "macro" }
import type { SchemaFile } from "./load-schemas"

export type { SchemaFile }

const SCHEMAS: Record<SchemaFile, string> = loadSchemas()

/** The file a schema describes, keyed by schema file. */
export const SCHEMA_TARGETS: Record<SchemaFile, string> = {
  "canette.json": "canette.yaml",
  "canette-template.json": "canette-template.yaml",
}

/** Schema file for "canette.yaml" / "canette-template.yaml" (or the schema file name itself). */
export function schemaFileFor(target: string): SchemaFile | undefined {
  for (const [file, yaml] of Object.entries(SCHEMA_TARGETS) as [SchemaFile, string][]) {
    if (target === yaml || target === file) return file
  }
  return undefined
}

export function getSchema(file: SchemaFile): string {
  return SCHEMAS[file]
}
