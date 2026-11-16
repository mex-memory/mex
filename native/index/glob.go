package index

import (
	pathscope "github.com/mex-memory/mex/native/internal/scope"
	"regexp"
	"strconv"
)

func MatchesScope(scope, file string) bool            { return pathscope.MatchesScope(scope, file) }
func CompileGlob(glob string) (*regexp.Regexp, error) { return pathscope.CompileGlob(glob) }
func globRegexp(glob string) (*regexp.Regexp, error)  { return pathscope.CompileGlob(glob) }
func normalizeGlob(glob string) string                { return pathscope.Normalize(glob) }
func globPrefix(glob string) string                   { return pathscope.Prefix(glob) }
func isLiteral(glob string) bool                      { return pathscope.Literal(glob) }
func strconvItoa(n int) string                        { return strconv.Itoa(n) }
