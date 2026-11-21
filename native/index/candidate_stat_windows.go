package index

import (
	"os"
	"path/filepath"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

type candidateStats struct{ *os.File }

var queryCandidateAttributes = windows.NewLazySystemDLL("ntdll.dll").NewProc("NtQueryAttributesFile")

func openCandidateStats(path string) (candidateStats, error) {
	if err := queryCandidateAttributes.Find(); err != nil {
		return candidateStats{}, err
	}
	root, err := os.Open(path)
	return candidateStats{root}, err
}

// Query only metadata, directly relative to the checkout handle. Refusing
// reparse points keeps the fast path contained even if a directory is replaced
// while the scan is in progress.
func (s candidateStats) mtime(path string) (time.Time, error) {
	name, err := windows.NewNTUnicodeString(filepath.FromSlash(path))
	if err != nil {
		return time.Time{}, err
	}
	var attrs windows.OBJECT_ATTRIBUTES
	attrs.Length = uint32(unsafe.Sizeof(attrs))
	attrs.RootDirectory = windows.Handle(s.Fd())
	attrs.ObjectName = name
	attrs.Attributes = windows.OBJ_CASE_INSENSITIVE | windows.OBJ_DONT_REPARSE
	var info struct {
		creation, access, write, change windows.Filetime
		attributes                      uint32
		_                               uint32
	}
	status, _, _ := syscall.SyscallN(queryCandidateAttributes.Addr(), uintptr(unsafe.Pointer(&attrs)), uintptr(unsafe.Pointer(&info)))
	switch windows.NTStatus(status) {
	case windows.STATUS_SUCCESS:
		if info.attributes&(windows.FILE_ATTRIBUTE_DIRECTORY|windows.FILE_ATTRIBUTE_REPARSE_POINT|windows.FILE_ATTRIBUTE_DEVICE) != 0 {
			return time.Time{}, nil
		}
		return time.Unix(0, info.write.Nanoseconds()), nil
	case windows.STATUS_REPARSE_POINT_ENCOUNTERED:
		return time.Time{}, nil
	default:
		return time.Time{}, windows.NTStatus(status).Errno()
	}
}
