// Package crypto implements AES-256-GCM encryption/decryption compatible with
// the TypeScript crypto.ts in apps/api.
//
// Wire format: base64( iv[12] || authTag[16] || ciphertext[N] )
package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
)

// NewKey decodes and validates a 64-character hex string into a 32-byte AES key.
// Call once at startup and fatal on error.
func NewKey(hexStr string) ([]byte, error) {
	if len(hexStr) != 64 {
		return nil, fmt.Errorf("ENCRYPTION_KEY must be 64 hex chars (32 bytes), got %d chars", len(hexStr))
	}
	b, err := hex.DecodeString(hexStr)
	if err != nil {
		return nil, fmt.Errorf("ENCRYPTION_KEY is not valid hex: %w", err)
	}
	return b, nil
}

// Encrypt encrypts plaintext and returns a base64-encoded blob.
// Wire format matches crypto.ts: base64( iv[12] || authTag[16] || ciphertext[N] )
func Encrypt(plaintext string, key []byte) (string, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("new cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("new gcm: %w", err)
	}
	iv := make([]byte, 12)
	if _, err := io.ReadFull(rand.Reader, iv); err != nil {
		return "", fmt.Errorf("read random iv: %w", err)
	}
	// gcm.Seal returns: encrypted[N] || tag[16]
	sealed := gcm.Seal(nil, iv, []byte(plaintext), nil)
	tagSize := gcm.Overhead() // always 16
	encrypted := sealed[:len(sealed)-tagSize]
	authTag := sealed[len(sealed)-tagSize:]

	// Reorder to match TypeScript wire format: iv || authTag || ciphertext
	out := make([]byte, 0, 12+tagSize+len(encrypted))
	out = append(out, iv...)
	out = append(out, authTag...)
	out = append(out, encrypted...)
	return base64.StdEncoding.EncodeToString(out), nil
}

// Decrypt decodes a base64 blob produced by Encrypt (or by crypto.ts) and
// returns the original plaintext.
func Decrypt(blob string, key []byte) (string, error) {
	data, err := base64.StdEncoding.DecodeString(blob)
	if err != nil {
		return "", fmt.Errorf("base64 decode: %w", err)
	}
	if len(data) < 28 { // 12 iv + 16 tag minimum
		return "", fmt.Errorf("ciphertext too short: %d bytes", len(data))
	}
	iv := data[:12]
	authTag := data[12:28]
	ciphertext := data[28:]

	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("new cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", fmt.Errorf("new gcm: %w", err)
	}
	// gcm.Open expects: ciphertext || tag — reassemble from our iv||tag||ciphertext format
	combined := make([]byte, len(ciphertext)+len(authTag))
	copy(combined, ciphertext)
	copy(combined[len(ciphertext):], authTag)

	plaintext, err := gcm.Open(nil, iv, combined, nil)
	if err != nil {
		return "", fmt.Errorf("decrypt: %w", err)
	}
	return string(plaintext), nil
}
