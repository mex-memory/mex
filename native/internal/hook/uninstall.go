package hook

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

const orphanCleanupTimeout = 5 * time.Second

// A detached copy owns the bounded Node process. The agent's hook must not
// wait for a cold Node startup (which can exceed 800 ms on Windows).
var orphanCleanupCommand = func() (*exec.Cmd, error) {
	self, err := os.Executable()
	if err != nil {
		return nil, err
	}
	return exec.Command(self, "--cleanup-orphan"), nil
}

// Only a definitely absent CLI means uninstalled. A broken launcher or a
// permission error must never authorize a settings edit. The independent,
// installed Node bundle survives npm uninstall; it reads the install mirror,
// never SQLite, and restores only recorded settings. No repo command runs.
func (h home) orphaned(sessionStart bool) bool {
	// Package-removal recovery is a session-start action. Keep metadata I/O off
	// the common tool hook path, including the counters-enabled timing path.
	if !sessionStart {
		return false
	}
	l, ok := h.launcher()
	if !ok {
		return false
	}
	if _, err := os.Stat(l.Entry); !errors.Is(err, os.ErrNotExist) {
		return false
	}
	if exists(filepath.Join(h.mex, "bin", "mex-hook.cjs")) {
		cmd, err := orphanCleanupCommand()
		if err == nil {
			if cmd.Env == nil {
				cmd.Env = os.Environ()
			}
			cmd.Env = append(cmd.Env, "MEX_HOME="+filepath.Dir(h.mex))
			cmd.Dir = h.mex
			cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
			detach(cmd)
			if cmd.Start() == nil {
				_ = cmd.Process.Release()
			}
		}
	}
	return true
}

// Revalidate the missing CLI in the worker: an install may have completed
// between the foreground observation and this process starting.
func cleanupOrphan(h home, timeout time.Duration) {
	l, ok := h.launcher()
	if !ok {
		return
	}
	if _, err := os.Stat(l.Entry); !errors.Is(err, os.ErrNotExist) {
		return
	}
	fallback := filepath.Join(h.mex, "bin", "mex-hook.cjs")
	if !exists(fallback) {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, l.Node, fallback, "--cleanup")
	cmd.WaitDelay = 100 * time.Millisecond
	cmd.Dir = h.mex
	cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
	detach(cmd)
	_ = cmd.Run()
}
