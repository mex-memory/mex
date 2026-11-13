//go:build !windows

package hook

import (
	"os"
	"syscall"
)

func singleTelemetryLink(_ string, info os.FileInfo) bool {
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Nlink == 1
}
