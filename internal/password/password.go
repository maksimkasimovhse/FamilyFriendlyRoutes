// Package password stores versioned, salted PBKDF2-HMAC-SHA256 hashes.
package password

import (
	"crypto/pbkdf2"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"strconv"
	"strings"
	"unicode/utf8"
)

const iterations = 600000

func Valid(value string) bool {
	n := utf8.RuneCountInString(value)
	return utf8.ValidString(value) && n >= 15 && n <= 128 && len(value) <= 1024 && strings.TrimSpace(value) != ""
}

func Hash(value string) (string, error) {
	if !Valid(value) {
		return "", errors.New("invalid password length")
	}
	salt := make([]byte, 16)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	key, err := pbkdf2.Key(sha256.New, value, salt, iterations, 32)
	if err != nil {
		return "", err
	}
	return "pbkdf2-sha256$" + strconv.Itoa(iterations) + "$" + base64.RawStdEncoding.EncodeToString(salt) + "$" + base64.RawStdEncoding.EncodeToString(key), nil
}

// Dummy provides the same KDF workload for unknown email addresses.
const Dummy = "pbkdf2-sha256$600000$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"

func Verify(encoded, value string) bool {
	p := strings.Split(encoded, "$")
	if len(p) != 4 || p[0] != "pbkdf2-sha256" {
		return false
	}
	n, err := strconv.Atoi(p[1])
	if err != nil || n != iterations {
		return false
	}
	salt, e1 := base64.RawStdEncoding.DecodeString(p[2])
	want, e2 := base64.RawStdEncoding.DecodeString(p[3])
	if e1 != nil || e2 != nil || len(salt) != 16 || len(want) != 32 {
		return false
	}
	key, err := pbkdf2.Key(sha256.New, value, salt, n, 32)
	return err == nil && subtle.ConstantTimeCompare(key, want) == 1
}
