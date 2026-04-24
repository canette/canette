// AES-256-GCM encryption/decryption for secret values.
// Wire format: base64( iv[12 bytes] || authTag[16 bytes] || ciphertext[N bytes] )
//
// ENCRYPTION_KEY must be a 64-char hex string (32 bytes) in the environment.
// The process throws at module load if the key is missing or malformed.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

function getMasterKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY
  if (!hex || hex.length !== 64 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error(
      "ENCRYPTION_KEY must be a 64-character hex string. " +
      "Generate one with: bun -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    )
  }
  return Buffer.from(hex, "hex")
}

// Load and validate at module initialisation — fail fast rather than on first request.
const KEY = getMasterKey()

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", KEY, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const authTag = cipher.getAuthTag() // 16 bytes
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64")
}

export function decrypt(blob: string): string {
  const buf = Buffer.from(blob, "base64")
  const iv = buf.subarray(0, 12)
  const authTag = buf.subarray(12, 28)
  const ciphertext = buf.subarray(28)
  const decipher = createDecipheriv("aes-256-gcm", KEY, iv)
  decipher.setAuthTag(authTag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8")
}
