package record

import (
	"os"
	"path/filepath"
	"syscall"
)

func existingAncestor(path string) string {
	for {
		if _, err := os.Stat(path); err == nil {
			return path
		}
		parent := filepath.Dir(path)
		if parent == path {
			return path
		}
		path = parent
	}
}

func isNetworkHome(path string) (bool, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(existingAncestor(path), &stat); err != nil {
		return false, err
	}
	switch uint64(stat.Type) & 0xffffffff {
	case 0x6969, 0x517b, 0xff534d42, 0xfe534d42:
		return true, nil
	default:
		return false, nil
	}
}
