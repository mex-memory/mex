package place

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"runtime"
	"strings"
)

// The path and identity helpers MEX's Go and Node code share. This package
// has no database code, so the hook shim can use it without linking SQLite.

// ShortHash is the first 24 hex characters of SHA-256, as Node's shortHash.
func ShortHash(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])[:24]
}

// AbsolutePath is an absolute, clean path; on Windows ASCII letters are
// lowercased, as Node's absolutePath does.
func AbsolutePath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if runtime.GOOS == "windows" {
		absolute = strings.Map(func(r rune) rune {
			if r >= 'A' && r <= 'Z' {
				return r + ('a' - 'A')
			}
			return r
		}, absolute)
	}
	return filepath.Clean(absolute), nil
}

// RealPath resolves links and normalizes like AbsolutePath, as Node's realPath.
func RealPath(path string) (string, error) {
	real, err := platformRealPath(path)
	if err != nil {
		return "", err
	}
	return AbsolutePath(real)
}

// RelativeToCheckout is file's path inside root ('/'-separated, in the file
// system's own spelling, as git lists it), or false when it is outside. root is
// a normalized checkout path as the record stores it.
func RelativeToCheckout(root, file string) (string, bool) {
	real, err := platformRealPath(file)
	if err != nil {
		return "", false
	}
	normalized, err := AbsolutePath(real)
	if err != nil || len(normalized) != len(real) {
		return "", false
	}
	prefix := strings.TrimSuffix(root, string(filepath.Separator)) + string(filepath.Separator)
	if !strings.HasPrefix(normalized, prefix) {
		return "", false
	}
	return filepath.ToSlash(real[len(prefix):]), true
}
