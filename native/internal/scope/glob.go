// Package scope implements the shared checkout-relative scope dialect without storage.
package scope

import (
	"regexp"
	"runtime"
	"strings"
)

// MatchesScope applies the file index's glob dialect without opening an index.
func MatchesScope(scope, file string) bool {
	file = strings.ReplaceAll(file, `\`, "/")
	if len(scope) > 512 || len(file) > 4096 {
		return false
	}
	re, err := globRegexp(scope)
	return err == nil && re.MatchString(file)
}

// Scope globs, the same dialect as src/file-index/glob.ts: paths are relative
// to the checkout and '/'-separated; the glob is anchored at the checkout root.
// A "**" segment matches any number of folders, "*" anything within one
// segment, "?" one character within a segment, and "{a,b}" either alternative
// (inside one segment, no nesting). A trailing "/" means everything below.

func normalizeGlob(glob string) string {
	value := strings.ReplaceAll(glob, `\`, "/")
	for strings.HasPrefix(value, "./") {
		value = value[2:]
	}
	value = strings.TrimLeft(value, "/")
	if value == "" {
		value = "**"
	}
	if strings.HasSuffix(value, "/") {
		value += "**"
	}
	return value
}

// globRegexp compiles a scope glob.
// CompileGlob shares the file index's scope dialect with delivery.
func CompileGlob(glob string) (*regexp.Regexp, error) { return globRegexp(glob) }

func globRegexp(glob string) (*regexp.Regexp, error) {
	raw := strings.Split(normalizeGlob(glob), "/")
	segments := raw[:0:0]
	for i, segment := range raw {
		if segment == "**" && i > 0 && raw[i-1] == "**" {
			continue
		}
		segments = append(segments, segment)
	}
	var out strings.Builder
	needSlash := false
	for i, segment := range segments {
		last := i == len(segments)-1
		if segment == "**" {
			switch {
			case last && i == 0:
				out.WriteString(".*")
			case last:
				out.WriteString("(?:/.*)?")
			case i == 0:
				out.WriteString("(?:.*/)?")
				needSlash = false
			default:
				out.WriteString("/(?:.*/)?")
				needSlash = false
			}
			continue
		}
		if needSlash {
			out.WriteString("/")
		}
		out.WriteString(segmentSource(segment))
		needSlash = true
	}
	pattern := "^" + out.String() + "$"
	if runtime.GOOS == "windows" {
		pattern = "(?i)" + pattern
	}
	return regexp.Compile(pattern)
}

func segmentSource(segment string) string {
	var out strings.Builder
	for i := 0; i < len(segment); i++ {
		c := segment[i]
		switch c {
		case '*':
			out.WriteString("[^/]*")
			continue
		case '?':
			out.WriteString("[^/]")
			continue
		case '{':
			if end := strings.IndexByte(segment[i:], '}'); end > 0 {
				parts := strings.Split(segment[i+1:i+end], ",")
				for j, part := range parts {
					parts[j] = segmentSource(part)
				}
				out.WriteString("(?:" + strings.Join(parts, "|") + ")")
				i += end
				continue
			}
		}
		if strings.IndexByte(`.+^$()|[]\{}`, c) >= 0 {
			out.WriteByte('\\')
		}
		out.WriteByte(c)
	}
	return out.String()
}

// globPrefix is the literal text every match starts with.
func globPrefix(glob string) string {
	value := normalizeGlob(glob)
	if i := strings.IndexAny(value, "*?{"); i >= 0 {
		return value[:i]
	}
	return value
}

func isLiteral(pathOrGlob string) bool {
	return !strings.ContainsAny(pathOrGlob, "*?{") && !strings.HasSuffix(pathOrGlob, "/")
}

func Normalize(glob string) string { return normalizeGlob(glob) }
func Prefix(glob string) string    { return globPrefix(glob) }
func Literal(glob string) bool     { return isLiteral(glob) }
