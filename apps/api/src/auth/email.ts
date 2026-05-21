import { Resend } from "resend"

export interface EmailProvider {
  send(opts: { to: string; subject: string; html: string; text: string }): Promise<void>
}

class ResendProvider implements EmailProvider {
  private client: Resend
  private from: string

  constructor(apiKey: string, from: string) {
    this.client = new Resend(apiKey)
    this.from = from
  }

  async send(opts: { to: string; subject: string; html: string; text: string }): Promise<void> {
    const { error } = await this.client.emails.send({
      from: this.from,
      to: opts.to,
      subject: opts.subject,
      html: opts.html,
      text: opts.text,
    })
    if (error) throw new Error(`Resend error: ${error.message}`)
  }
}

export function createEmailProvider(): EmailProvider | null {
  const provider = process.env.EMAIL_PROVIDER ?? ""
  if (!provider || provider === "none") return null

  if (provider === "resend") {
    const apiKey = process.env.RESEND_API_KEY
    if (!apiKey) {
      console.warn("EMAIL_PROVIDER=resend but RESEND_API_KEY is not set — magic link disabled")
      return null
    }
    const from = process.env.EMAIL_FROM ?? "canette <noreply@example.com>"
    return new ResendProvider(apiKey, from)
  }

  console.warn(`Unknown EMAIL_PROVIDER "${provider}" — magic link disabled`)
  return null
}
