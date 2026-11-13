package hook

import (
	"os/exec"
	"syscall"
)

// detach starts the process outside the agent's console and process group, so
// it outlives the hook and never opens a window.
func detach(cmd *exec.Cmd) {
	const detachedProcess = 0x00000008
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CreationFlags: detachedProcess | syscall.CREATE_NEW_PROCESS_GROUP,
		HideWindow:    true,
	}
}
