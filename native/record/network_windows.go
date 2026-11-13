package record

import (
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

var getDriveType = syscall.NewLazyDLL("kernel32.dll").NewProc("GetDriveTypeW")

func isNetworkHome(path string) (bool, error) {
	if strings.HasPrefix(path, `\\`) {
		return true, nil
	}
	root, err := syscall.UTF16PtrFromString(filepath.VolumeName(path) + `\`)
	if err != nil {
		return false, err
	}
	if err := getDriveType.Find(); err != nil {
		return false, err
	}
	kind, _, _ := getDriveType.Call(uintptr(unsafe.Pointer(root)))
	return kind == 4, nil // DRIVE_REMOTE
}
