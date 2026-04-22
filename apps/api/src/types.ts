import type { auth } from "./auth"

export type AppEnv = {
  Variables: {
    session: typeof auth.$Infer.Session
  }
}
