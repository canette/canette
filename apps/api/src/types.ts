import type { auth } from "./auth/auth"

export type AppEnv = {
  Variables: {
    session: typeof auth.$Infer.Session
  }
}
