package crypto

import (
	"strings"
	"testing"
)

func TestEncryptDecryptRoundtrip(t *testing.T) {
	key, err := NewKey(strings.Repeat("a1", 32)) // 64 hex chars
	if err != nil {
		t.Fatalf("NewKey: %v", err)
	}

	plaintext := "super secret value"

	blob, err := Encrypt(plaintext, key)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}

	got, err := Decrypt(blob, key)
	if err != nil {
		t.Fatalf("Decrypt: %v", err)
	}

	if got != plaintext {
		t.Errorf("roundtrip mismatch: got %q, want %q", got, plaintext)
	}
}
