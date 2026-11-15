package hook

import (
	"crypto/rand"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record/place"
)

// A bounded wake-up request, never a model call or a write to Node's tables.
// Each checkout has one atomically replaced file. New edits replace old hints.
func requestJudge(ev contract.Event, recordDirectory string, paths []string) {
	if recordDirectory == "" || ev.ProjectID == "" || ev.Checkout == "" || (ev.Agent != "claude-code" && ev.Agent != "codex") {
		return
	}
	now := time.Now()
	reason, notBefore := "edit", now.Add(30*time.Second).UnixMilli()
	if ev.Kind == contract.SessionStart {
		reason, notBefore = "start", now.UnixMilli()
	} else if ev.Kind == contract.Stop {
		reason, notBefore = "idle", now.UnixMilli()
	}
	near := []string{}
	bytes := 0
	for _, path := range paths {
		if len(path) > 512 || bytes+len(path) > 8192 || len(near) == 128 {
			continue
		}
		near = append(near, path)
		bytes += len(path)
	}
	data, err := json.Marshal(struct {
		Version    int      `json:"version"`
		Project    string   `json:"project_id"`
		Checkout   string   `json:"checkout"`
		Agent      string   `json:"agent"`
		Reason     string   `json:"reason"`
		Generation string   `json:"generation"`
		Near       []string `json:"near"`
		NotBefore  int64    `json:"not_before"`
	}{1, ev.ProjectID, ev.Checkout, ev.Agent, reason, strconv.FormatInt(now.UnixNano(), 10), near, notBefore})
	if err != nil || len(data) > 16<<10 {
		return
	}
	root, err := os.OpenRoot(recordDirectory)
	if err != nil {
		return
	}
	defer root.Close()
	if root.MkdirAll("judge-pending", 0o700) != nil {
		return
	}
	info, err := root.Lstat("judge-pending")
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return
	}
	temporary := filepath.Join("judge-pending", ".request-"+rand.Text())
	f, err := root.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	defer root.Remove(temporary)
	_, writeErr := f.Write(data)
	closeErr := f.Close()
	if writeErr == nil && closeErr == nil {
		_ = root.Rename(temporary, filepath.Join("judge-pending", place.ShortHash(ev.Checkout)+".json"))
	}
}
