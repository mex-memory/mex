package hook

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"

	localrecord "github.com/mex-memory/mex/native/record"
)

func explicitProbe(stdin io.Reader, stdout io.Writer, getenv Env) int {
	var in struct{ Entry, Kind, Session, Project, Checkout string }
	if json.NewDecoder(io.LimitReader(stdin, 16384)).Decode(&in) != nil || (in.Kind != "opened" && in.Kind != "wrong") {
		_, _ = io.WriteString(stdout, "{}\n")
		return 0
	}
	directory := homeFrom(getenv).recordDirectory()
	file := filepath.Join(directory, "hooks.db")
	for _, name := range []string{"hooks.db", "hooks.db-wal", "hooks.db-shm"} {
		if !safeTelemetryFile(filepath.Join(directory, name)) {
			_, _ = io.WriteString(stdout, "{}\n")
			return 0
		}
	}
	if _, err := os.Stat(file); err != nil {
		_, _ = io.WriteString(stdout, "{}\n")
		return 0
	}
	h, err := localrecord.OpenHooks(localrecord.Location{Directory: directory, Hooks: file})
	if err != nil {
		_, _ = io.WriteString(stdout, "{}\n")
		return 0
	}
	defer h.Close()
	ok, err := h.ExplicitProbe(in.Entry, in.Kind, in.Session, in.Project, in.Checkout)
	_ = json.NewEncoder(stdout).Encode(map[string]bool{"ok": ok && err == nil})
	return 0
}
