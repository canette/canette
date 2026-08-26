package main

import (
	"testing"
	"time"
)

func TestSessionRoundtrip(t *testing.T) {
	now := time.Now()
	token := signSession("$2b$10$hash", now)
	if err := verifySession(token, "$2b$10$hash", now.Add(time.Hour)); err != nil {
		t.Fatalf("expected valid session, got %v", err)
	}
}

func TestSessionExpired(t *testing.T) {
	now := time.Now()
	token := signSession("$2b$10$hash", now)
	if err := verifySession(token, "$2b$10$hash", now.Add(sessionTTL+time.Minute)); err == nil {
		t.Fatal("expected expired session to be rejected")
	}
}

func TestSessionTamperedSignature(t *testing.T) {
	now := time.Now()
	token := signSession("$2b$10$hash", now)
	tampered := token[:len(token)-1] + "x"
	if tampered == token {
		t.Fatal("test setup did not actually tamper the token")
	}
	if err := verifySession(tampered, "$2b$10$hash", now); err == nil {
		t.Fatal("expected tampered session to be rejected")
	}
}

func TestSessionWrongPasswordHash(t *testing.T) {
	// Changing the password (which changes the stored bcrypt hash) must
	// invalidate every session signed under the old hash, since the session
	// key is derived from it.
	now := time.Now()
	token := signSession("$2b$10$old-hash", now)
	if err := verifySession(token, "$2b$10$new-hash", now); err == nil {
		t.Fatal("expected session signed under a different password hash to be rejected")
	}
}

func TestSessionMalformedToken(t *testing.T) {
	cases := []string{"", "no-dot-here", "a.b.c", "!!!.!!!"}
	for _, tok := range cases {
		if err := verifySession(tok, "$2b$10$hash", time.Now()); err == nil {
			t.Errorf("expected malformed token %q to be rejected", tok)
		}
	}
}
