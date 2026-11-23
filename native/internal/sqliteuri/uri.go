// Package sqliteuri encodes filesystem paths for SQLite connection strings.
package sqliteuri

import (
	"net/url"
	"strings"
)

// File keeps the supplied path intact when SQLite decodes the URI. Callers
// can set RawQuery to attach connection options.
func File(path string) url.URL {
	escaped := (&url.URL{Path: path}).EscapedPath()
	// SQLite checks the authority before unescaping the path. Preserve
	// Windows backslashes as escapes and give a leading // an empty authority.
	if strings.HasPrefix(path, "//") {
		escaped = "//" + escaped
	}
	return url.URL{Scheme: "file", Opaque: escaped}
}

// Immutable returns the URI for a read-only, lock-free published database.
func Immutable(path string) string {
	uri := File(path)
	uri.RawQuery = "mode=ro&immutable=1"
	return uri.String()
}
