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

// Only a definitely absent CLI means uninstalled. A broken launcher or a
// permission error must never authorize a settings edit. The independent,
// installed Node bundle survives npm uninstall; it reads the install mirror,
// never SQLite, and restores only recorded settings. No repo command runs.
func (h home) orphaned(sessionStart bool) bool {
	l, ok := h.launcher()
	if !ok {
		return false
	}
	if _, err := os.Stat(l.Entry); !errors.Is(err, os.ErrNotExist) {
		return false
	}
	if sessionStart {
		fallback := filepath.Join(h.mex, "bin", "mex-hook.cjs")
		if exists(fallback) {
			ctx, cancel := context.WithTimeout(context.Background(), 800*time.Millisecond)
			defer cancel()
			cmd := exec.CommandContext(ctx, l.Node, fallback, "--cleanup")
			cmd.Dir = h.mex
			cmd.Stdout, cmd.Stderr = io.Discard, io.Discard
			_ = cmd.Run()
		}
	}
	return true
}
