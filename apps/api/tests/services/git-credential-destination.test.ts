import { afterEach, describe, expect, it } from "bun:test"
import { credentialDestinationError } from "../../src/services/git-credential-destination"

const original = process.env.GIT_CREDENTIAL_ALLOWED_ORIGINS

afterEach(() => {
  if (original === undefined) delete process.env.GIT_CREDENTIAL_ALLOWED_ORIGINS
  else process.env.GIT_CREDENTIAL_ALLOWED_ORIGINS = original
})

const githubPat = { provider: "github", type: "pat" }
const gitlabPat = { provider: "gitlab", type: "pat" }
const giteaPat = { provider: "gitea", type: "pat" }
const genericPat = { provider: "generic", type: "pat" }
const githubApp = { provider: "github", type: "github_app" }
const sshKey = { provider: "generic", type: "ssh_key" }

describe("credentialDestinationError", () => {
  it("allows each provider's public host", () => {
    expect(credentialDestinationError(githubPat, "https://github.com/a/b.git")).toBeNull()
    expect(credentialDestinationError(githubApp, "https://github.com/a/b")).toBeNull()
    expect(credentialDestinationError(gitlabPat, "https://gitlab.com/a/b.git")).toBeNull()
  })

  it("rejects a provider's credential on another provider's public host", () => {
    expect(credentialDestinationError(githubPat, "https://gitlab.com/a/b.git")).not.toBeNull()
    expect(credentialDestinationError(gitlabPat, "https://github.com/a/b.git")).not.toBeNull()
  })

  it("rejects unknown hosts unless an administrator allowed them", () => {
    delete process.env.GIT_CREDENTIAL_ALLOWED_ORIGINS
    expect(credentialDestinationError(giteaPat, "https://git.example.com/a/b.git")).not.toBeNull()
    expect(credentialDestinationError(genericPat, "https://git.example.com/a/b.git")).not.toBeNull()

    process.env.GIT_CREDENTIAL_ALLOWED_ORIGINS = "https://other.example, https://git.example.com"
    expect(credentialDestinationError(giteaPat, "https://git.example.com/a/b.git")).toBeNull()
    expect(credentialDestinationError(genericPat, "https://git.example.com/a/b.git")).toBeNull()
  })

  it("matches the port exactly", () => {
    process.env.GIT_CREDENTIAL_ALLOWED_ORIGINS = "https://git.example.com:3443"
    expect(credentialDestinationError(giteaPat, "https://git.example.com:3443/a/b")).toBeNull()
    expect(credentialDestinationError(giteaPat, "https://git.example.com/a/b")).not.toBeNull()
  })

  it("never lets an allowlist entry admit GitHub App tokens", () => {
    process.env.GIT_CREDENTIAL_ALLOWED_ORIGINS = "https://git.example.com"
    expect(credentialDestinationError(githubApp, "https://git.example.com/a/b")).not.toBeNull()
  })

  it("rejects plain http, even for an allowlisted host", () => {
    process.env.GIT_CREDENTIAL_ALLOWED_ORIGINS = "https://git.example.com"
    expect(credentialDestinationError(giteaPat, "http://git.example.com/a/b")).not.toBeNull()
  })

  it("ignores invalid allowlist entries", () => {
    process.env.GIT_CREDENTIAL_ALLOWED_ORIGINS = "http://git.example.com,https://git.example.com/path,https://u:p@x.example"
    expect(credentialDestinationError(giteaPat, "https://git.example.com/a/b")).not.toBeNull()
    expect(credentialDestinationError(giteaPat, "https://x.example/a/b")).not.toBeNull()
  })

  it("fails closed on non-canonical or unknown-scheme URLs", () => {
    for (const url of [
      "https:attacker.example/a/b",
      "https:/attacker.example/a/b",
      "https://github.com\\@attacker.example/a/b",
      "https:\\\\github.com/a/b",
      "https://user@github.com/a/b",
      "https://github.com:x@attacker.example/a/b",
      "ftp://github.com/a/b",
      "file:///etc/passwd",
      "attacker.example/a/b",
    ]) {
      expect(credentialDestinationError(githubPat, url)).not.toBeNull()
    }
  })

  it("allows SSH keys and SSH URLs, which never carry a token", () => {
    expect(credentialDestinationError(sshKey, "https://anything.example/a/b")).toBeNull()
    expect(credentialDestinationError(githubPat, "git@attacker.example:a/b.git")).toBeNull()
    expect(credentialDestinationError(githubPat, "ssh://git@attacker.example/a/b.git")).toBeNull()
  })
})
