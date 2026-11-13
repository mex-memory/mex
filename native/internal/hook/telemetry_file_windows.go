package hook

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

func safeTelemetryFile(path string) bool {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return false
	}
	if !strings.HasPrefix(absolute, `\\?\`) {
		if strings.HasPrefix(absolute, `\\`) {
			absolute = `\\?\UNC\` + absolute[2:]
		} else {
			absolute = `\\?\` + absolute
		}
	}
	name, err := syscall.UTF16PtrFromString(absolute)
	if err != nil {
		return false
	}
	// Inspect type and link count through one metadata-only handle. Opening
	// the reparse point itself prevents following a file that is swapped for
	// a symlink between separate path-stat and open operations.
	const fileReadAttributes = 0x0080
	handle, err := syscall.CreateFile(name, fileReadAttributes,
		syscall.FILE_SHARE_READ|syscall.FILE_SHARE_WRITE|syscall.FILE_SHARE_DELETE,
		nil, syscall.OPEN_EXISTING, syscall.FILE_FLAG_OPEN_REPARSE_POINT|syscall.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return os.IsNotExist(err)
	}
	defer syscall.CloseHandle(handle)
	kind, err := syscall.GetFileType(handle)
	if err != nil || kind != syscall.FILE_TYPE_DISK {
		return false
	}
	var info syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(handle, &info); err != nil {
		return false
	}
	return info.FileAttributes&(syscall.FILE_ATTRIBUTE_DIRECTORY|syscall.FILE_ATTRIBUTE_REPARSE_POINT) == 0 && info.NumberOfLinks == 1
}
