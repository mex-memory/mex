package record

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPublishedHomeDoesNotDependOnUnusedCache(t *testing.T) {
	first, err := ResolveLocation(LocationOptions{Home: t.TempDir(), Cache: t.TempDir(), IsNetwork: func(string) (bool, error) { return false, nil }})
	if err != nil {
		t.Fatal(err)
	}
	pointer := filepath.Join(first.Home, "location")
	before, err := os.ReadFile(pointer)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"MEX_HOME", "HOME", "USERPROFILE", "LOCALAPPDATA", "XDG_CACHE_HOME"} {
		t.Setenv(key, "")
	}
	second, err := ResolveLocation(LocationOptions{Home: first.Home, ReadOnly: true, IsNetwork: func(string) (bool, error) {
		t.Fatal("published location invoked network detection")
		return false, nil
	}})
	if err != nil || second != first {
		t.Fatalf("published home with no user/cache environment: %+v %v", second, err)
	}
	after, err := os.ReadFile(pointer)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatalf("read-only lookup changed the pointer: %v", err)
	}
}

func TestPublishedHomeStillValidatesPointer(t *testing.T) {
	home := filepath.Join(t.TempDir(), "Bêta home")
	cache := t.TempDir()
	first, err := ResolveLocation(LocationOptions{Home: home, Cache: cache, IsNetwork: func(string) (bool, error) { return false, nil }})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name, value string
		fallback    bool
	}{
		{"canonical-home", first.Home + "\n", false},
		{"outside", t.TempDir(), true},
		{"relative", "relative/path", true},
		{"nul", first.Home + "\x00", true},
		{"oversized", strings.Repeat(" ", 4096) + first.Home, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			pointer := filepath.Join(first.Home, "location")
			if err := os.WriteFile(pointer, []byte(test.value), 0600); err != nil {
				t.Fatal(err)
			}
			calls := 0
			got, err := ResolveLocation(LocationOptions{Home: home, Cache: cache, ReadOnly: true, IsNetwork: func(string) (bool, error) {
				calls++
				return false, nil
			}})
			if err != nil || got != first || (calls != 0) != test.fallback {
				t.Fatalf("pointer resolution: %+v calls=%d fallback=%t err=%v", got, calls, test.fallback, err)
			}
			after, err := os.ReadFile(pointer)
			if err != nil || string(after) != test.value {
				t.Fatalf("read-only lookup repaired the pointer: %v", err)
			}
		})
	}
}
