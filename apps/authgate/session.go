package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"time"
)

const sessionCookieName = "__Host-canette_gate"

const sessionTTL = 24 * time.Hour

var errInvalidSession = errors.New("invalid session")

// sessionKey derives the HMAC signing key from the app's bcrypt password hash.
// This needs no separate secret to provision, mount, or rotate — and since the
// key is derived from the hash, changing the password (which changes the
// hash) invalidates every session signed under the old password for free.
func sessionKey(passwordHash string) []byte {
	sum := sha256.Sum256([]byte(passwordHash))
	return sum[:]
}

// signSession returns a session token: base64url(expiryUnix) + "." + base64url(hmac).
func signSession(passwordHash string, now time.Time) string {
	payload := strconv.FormatInt(now.Add(sessionTTL).Unix(), 10)
	mac := hmac.New(sha256.New, sessionKey(passwordHash))
	mac.Write([]byte(payload))
	sig := mac.Sum(nil)
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + base64.RawURLEncoding.EncodeToString(sig)
}

// verifySession validates a session token's signature and expiry.
func verifySession(token, passwordHash string, now time.Time) error {
	parts := strings.SplitN(token, ".", 2)
	if len(parts) != 2 {
		return errInvalidSession
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return errInvalidSession
	}
	gotSig, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return errInvalidSession
	}

	mac := hmac.New(sha256.New, sessionKey(passwordHash))
	mac.Write(payload)
	wantSig := mac.Sum(nil)
	if subtle.ConstantTimeCompare(gotSig, wantSig) != 1 {
		return errInvalidSession
	}

	expUnix, err := strconv.ParseInt(string(payload), 10, 64)
	if err != nil {
		return errInvalidSession
	}
	if now.After(time.Unix(expUnix, 0)) {
		return errInvalidSession
	}
	return nil
}
