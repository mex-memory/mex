package hook

import (
	"os"
	"syscall"
)

func singleTelemetryLink(path string, expected os.FileInfo) bool {
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	current, err := file.Stat()
	if err != nil || !current.Mode().IsRegular() || !os.SameFile(expected, current) {
		return false
	}
	var info syscall.ByHandleFileInformation
	return syscall.GetFileInformationByHandle(syscall.Handle(file.Fd()), &info) == nil && info.NumberOfLinks == 1
}
