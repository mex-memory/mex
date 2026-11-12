package record

import (
	"fmt"
	"path/filepath"
	"strings"
	"syscall"
	"unsafe"
)

var getFinalPathName = syscall.NewLazyDLL("kernel32.dll").NewProc("GetFinalPathNameByHandleW")

// Match Node's native realpath: dereference links and obtain the filesystem's
// actual Unicode spelling, rather than applying language-specific case maps.
func platformRealPath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(absolute, `\\?\`) {
		if strings.HasPrefix(absolute, `\\`) {
			absolute = `\\?\UNC\` + absolute[2:]
		} else {
			absolute = `\\?\` + absolute
		}
	}
	pointer, err := syscall.UTF16PtrFromString(absolute)
	if err != nil {
		return "", err
	}
	handle, err := syscall.CreateFile(pointer, 0, syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE, nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", err
	}
	defer syscall.CloseHandle(handle)
	if err := getFinalPathName.Find(); err != nil {
		return "", err
	}
	for size := 260; size <= 32768; {
		buffer := make([]uint16, size)
		length, _, callErr := getFinalPathName.Call(uintptr(handle), uintptr(unsafe.Pointer(&buffer[0])), uintptr(size), 0)
		if length == 0 {
			return "", fmt.Errorf("resolve real path: %w", callErr)
		}
		if int(length) >= size {
			size = int(length) + 1
			continue
		}
		resolved := syscall.UTF16ToString(buffer[:length])
		if strings.HasPrefix(resolved, `\\?\UNC\`) {
			return `\\` + resolved[8:], nil
		}
		return strings.TrimPrefix(resolved, `\\?\`), nil
	}
	return "", fmt.Errorf("resolved path exceeds Windows path limit")
}
