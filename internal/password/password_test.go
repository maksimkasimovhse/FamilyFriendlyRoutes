package password

import (
	"strings"
	"testing"
)

func TestSaltedHashesAndVerification(t *testing.T) {
	value := "Мой длинный пароль 123"
	a, err := Hash(value)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Hash(value)
	if err != nil {
		t.Fatal(err)
	}
	if a == b || strings.Contains(a, value) || !Verify(a, value) || Verify(a, value+"!") || Verify(Dummy, value) {
		t.Fatal("invalid password hashing or verification")
	}
	for _, bad := range []string{"", "short", strings.Repeat(" ", 20), strings.Repeat("x", 129)} {
		if Valid(bad) {
			t.Fatalf("accepted invalid password length %d", len(bad))
		}
	}
	if !Valid("  spaces are preserved  ") || Verify(a, " "+value) {
		t.Fatal("password whitespace must be preserved")
	}
	for _, bad := range []string{"sha256$abc", strings.Replace(a, "600000", "600000000", 1), strings.Replace(a, "pbkdf2", "invalid", 1)} {
		if Verify(bad, value) {
			t.Fatal("accepted corrupt hash")
		}
	}
}
