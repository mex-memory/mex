package place

import (
	"os"
	"path/filepath"
	"syscall"
)

func isNetworkHome(path string) (bool, error) {
	for {
		if _, err := os.Stat(path); err == nil {
			break
		}
		parent := filepath.Dir(path)
		if parent == path {
			break
		}
		path = parent
	}
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return false, err
	}
	bytes := []byte{}
	for _, c := range stat.Fstypename {
		if c == 0 {
			break
		}
		bytes = append(bytes, byte(c))
	}
	switch string(bytes) {
	case "nfs", "smbfs", "cifs", "afpfs", "webdav":
		return true, nil
	}
	return false, nil
}
