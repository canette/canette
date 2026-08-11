import { load } from "js-yaml"

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
