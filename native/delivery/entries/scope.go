package entries

import (
	"regexp"
	"strings"

	"github.com/mex-memory/mex/native/index"
)

// Scope matches a scope glob (the file index's dialect) against a path
// relative to the checkout. The common shapes, a plain file, "dir/**" and
// "**", match without a regular expression; only other globs are compiled.
type Scope struct {
	Glob   string
	all    bool
	exact  string
	prefix string
	re     *regexp.Regexp
}

func newScope(glob string) (*Scope, error) {
	s := &Scope{Glob: glob}
	n := strings.ReplaceAll(glob, `\`, "/")
	for strings.HasPrefix(n, "./") {
		n = n[2:]
	}
	n = strings.TrimLeft(n, "/")
	if n == "" {
		n = "**"
	}
	if strings.HasSuffix(n, "/") {
		n += "**"
	}
	for strings.HasPrefix(n, "**/**") {
		n = n[3:]
	}
	const special = "*?{}[]"
	switch {
	case n == "**":
		s.all = true
	case !strings.ContainsAny(n, special):
		s.exact = n
	case strings.HasSuffix(n, "/**") && !strings.ContainsAny(n[:len(n)-3], special):
		s.prefix = n[:len(n)-3]
	default:
		re, err := index.CompileGlob(glob)
		if err != nil {
			return nil, err
		}
		s.re = re
	}
	return s, nil
}

// MatchString reports whether rel ('/'-separated, relative) is in scope.
func (s *Scope) MatchString(rel string) bool {
	switch {
	case s.all:
		return true
	case s.exact != "":
		return rel == s.exact
	case s.prefix != "":
		return rel == s.prefix || strings.HasPrefix(rel, s.prefix+"/")
	}
	return s.re != nil && s.re.MatchString(rel)
}
