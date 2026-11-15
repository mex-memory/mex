package hook

import (
	"crypto/rand"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/mex-memory/mex/native/check"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record/place"
)

type judgeRequest struct {
	Version    int      `json:"version"`
	Project    string   `json:"project_id"`
	Checkout   string   `json:"checkout"`
	Agent      string   `json:"agent"`
	SessionID  string   `json:"session_id,omitempty"`
	Reason     string   `json:"reason"`
	Generation string   `json:"generation"`
	Near       []string `json:"near"`
	NotBefore  int64    `json:"not_before"`
}

func needsJudge(report check.StageReport) bool {
	if report.Unfinished || report.Counts[check.Changed] > 0 || report.Counts[check.Broken] > 0 {
		return true
	}
	for _, result := range report.Results {
		for _, c := range result.Checks {
			if c.Role == check.Complete && len(c.FilesChanged) > 0 {
				return true
			}
		}
	}
	return false
}

// A bounded wake-up request, never a model call or a write to Node's tables.
// Each checkout has one atomically replaced file. New edits replace old hints.
func requestJudge(ev contract.Event, recordDirectory string, paths []string) bool {
	if recordDirectory == "" || ev.ProjectID == "" || ev.Checkout == "" || (ev.Agent != "claude-code" && ev.Agent != "codex") {
		return false
	}
	root, err := os.OpenRoot(recordDirectory)
	if err != nil {
		return false
	}
	defer root.Close()
	name := filepath.Join("judge-pending", place.ShortHash(ev.Checkout)+".json")
	if ev.Kind == contract.Stop {
		// Stop releases existing work, and never creates an empty judge job.
		// Preserve the edit's nearest paths and do not release another session.
		f, err := root.Open(name)
		if err != nil {
			return false
		}
		stat, statErr := f.Stat()
		data, readErr := io.ReadAll(io.LimitReader(f, (16<<10)+1))
		_ = f.Close()
		var prior judgeRequest
		if statErr != nil || !stat.Mode().IsRegular() || stat.Size() > 16<<10 || readErr != nil || len(data) > 16<<10 || json.Unmarshal(data, &prior) != nil ||
			prior.Version != 1 || prior.Project != ev.ProjectID || prior.Checkout != ev.Checkout || prior.Agent != ev.Agent || prior.SessionID != ev.SessionID {
			return false
		}
		paths = prior.Near
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
	data, err := json.Marshal(judgeRequest{1, ev.ProjectID, ev.Checkout, ev.Agent, ev.SessionID, reason, strconv.FormatInt(now.UnixNano(), 10), near, notBefore})
	if err != nil || len(data) > 16<<10 {
		return false
	}
	if root.MkdirAll("judge-pending", 0o700) != nil {
		return false
	}
	info, err := root.Lstat("judge-pending")
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return false
	}
	temporary := filepath.Join("judge-pending", ".request-"+rand.Text())
	f, err := root.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return false
	}
	defer root.Remove(temporary)
	_, writeErr := f.Write(data)
	closeErr := f.Close()
	if writeErr == nil && closeErr == nil {
		return root.Rename(temporary, name) == nil
	}
	return false
}
