import { load, YAMLException } from "js-yaml"
import { ServiceError } from "./errors"

// validateCanetteConfigYaml checks that canette.yaml parses and is a mapping at
// the top level. It does not check field names or values: the controller owns
// the schema and ignores unknown fields.
export function validateCanetteConfigYaml(yaml: string): void {
  // js-yaml throws on a document with no content, but a blank or fully
  // commented-out canette.yaml is valid and means "use the defaults".
  if (yaml.split("\n").every((line) => /^\s*(#.*)?$/.test(line))) return
  let parsed: unknown
  try {
    parsed = load(yaml)
  } catch (e) {
    if (e instanceof YAMLException) {
      // e.message spans several lines with a code excerpt; keep it to one line.
      const where = e.mark ? ` (line ${e.mark.line + 1}, column ${e.mark.column + 1})` : ""
      throw new ServiceError(`canetteConfig is not valid YAML: ${e.reason}${where}`, "VALIDATION_ERROR", 400)
    }
    throw e
  }
  if (parsed !== null && parsed !== undefined && (typeof parsed !== "object" || Array.isArray(parsed))) {
    throw new ServiceError(
      "canetteConfig must be a YAML mapping (key: value pairs) at the top level",
      "VALIDATION_ERROR",
      400
    )
  }
}

// getReplicasFromCanetteConfig parses the canette.yaml replicas field,
// defaulting to 1 when missing, unparseable, or not a number.
export function getReplicasFromCanetteConfig(canetteConfig: string | null | undefined): number {
  if (!canetteConfig || !canetteConfig.trim()) return 1
  try {
    const parsed = load(canetteConfig) as Record<string, unknown> | null
    if (parsed && typeof parsed === "object" && typeof parsed.replicas === "number") {
      return parsed.replicas
    }
  } catch {
    // parse error — treat as default
  }
  return 1
}
