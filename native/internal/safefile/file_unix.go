//go:build !windows

package safefile

import (
	"os"
	"syscall"
)

func Regular(path string) bool {
	info, err := os.Lstat(path)
	if err != nil {
		return os.IsNotExist(err)
	}
	if !info.Mode().IsRegular() {
		return false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Nlink == 1
}
