package delivery

import (
	"regexp"
	"sync"
)

// lazy compiles on first use: the hook pays no start-up cost for patterns a
// call never needs.
func lazy(pattern string) func() *regexp.Regexp {
	return sync.OnceValue(func() *regexp.Regexp { return regexp.MustCompile(pattern) })
}
