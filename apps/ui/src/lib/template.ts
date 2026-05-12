// Resolve {{apps.<originalSlug>.slug}} references using the map of original → chosen slugs.
export function resolveTemplateVars(
  value: string,
  slugMap: Record<string, string>,
): string {
  return value.replace(/\{\{apps\.([^.}]+)\.slug\}\}/g, (_, originalSlug) => {
    return slugMap[originalSlug] ?? originalSlug
  })
}

// Returns true if the value contains any unresolved template variable references.
export function hasTemplateVars(value: string): boolean {
  return /\{\{apps\.[^.}]+\.slug\}\}/.test(value)
}

// Build a slug map from an array of { originalSlug, chosenSlug } entries.
export function buildSlugMap(
  entries: Array<{ originalSlug: string; chosenSlug: string }>,
): Record<string, string> {
  return Object.fromEntries(entries.map(({ originalSlug, chosenSlug }) => [originalSlug, chosenSlug]))
}
