package check

import (
	"regexp"
	"sync"
)

// lazy compiles a pattern on first use. This package is linked into the
// hook shim, which would otherwise pay for every compile on each start.
func lazy(pattern string) func() *regexp.Regexp {
	return sync.OnceValue(func() *regexp.Regexp { return regexp.MustCompile(pattern) })
}
