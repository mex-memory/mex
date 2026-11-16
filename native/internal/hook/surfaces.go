package hook

import (
	"encoding/json"
	"io"
	"path/filepath"
	"strings"

	localrecord "github.com/mex-memory/mex/native/record"
)

func surfaceReport(stdin io.Reader, stdout io.Writer, getenv Env) int {
	var req struct {
		Project  string `json:"project"`
		Checkout string `json:"checkout"`
	}
	if json.NewDecoder(io.LimitReader(stdin, 16384)).Decode(&req) != nil || req.Project == "" || len(req.Project) > 128 || strings.ContainsRune(req.Project+req.Checkout, 0) {
		return 2
	}
	h := homeFrom(getenv)
	report, err := localrecord.ReadSurfaces(filepath.Join(h.recordDirectory(), "hooks.db"), req.Project, req.Checkout)
	if err != nil {
		_ = json.NewEncoder(stdout).Encode(map[string]any{"error": err.Error()})
		return 1
	}
	_ = json.NewEncoder(stdout).Encode(report)
	return 0
}
