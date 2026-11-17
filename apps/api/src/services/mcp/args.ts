export function arg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  return typeof v === "string" ? v : undefined
}

export function argBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args[key]
  if (typeof v === "boolean") return v
  if (v === "true") return true
  if (v === "false") return false
  return undefined
}

export function argNum(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  if (typeof v === "number") return v
  if (typeof v === "string") {
    const n = Number(v)
    return isNaN(n) ? undefined : n
  }
  return undefined
}

// An optional whole-number argument: undefined when absent, NaN when it was
// passed but is not a number, so the caller's range check rejects it.
export function argInt(args: Record<string, unknown>, key: string): number | undefined {
  if (args[key] === undefined || args[key] === null) return undefined
  return Math.trunc(argNum(args, key) ?? NaN)
}
