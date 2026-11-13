//go:build !windows

package hook

import (
	"os/exec"
	"syscall"
)

// detach starts the process in its own session, so it outlives the hook and
// the agent's terminal.
func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
