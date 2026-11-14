package hook

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	localrecord "github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
)

// A worktree is its own checkout of the same project: a read there uses the
// worktree's entry files and verdicts and its own ledger rows, never the main
// checkout's.
func TestDeliveryInAWorktree(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not available")
	}
	h, env := fakeHome(t, true)
	parent := t.TempDir()
	main := filepath.Join(parent, "main")
	gitRun := func(dir string, args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "safe.directory=*"}, args...)...)
		cmd.Dir = dir
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	os.MkdirAll(filepath.Join(main, "src"), 0o700)
	gitRun(parent, "init", "-q", main)
	entry := func(root, oneLine string) {
		learned := filepath.Join(root, ".mex", "learned")
		os.MkdirAll(learned, 0o700)
		body := "---\nmex:\n  id: mx_wtreep\n  kind: pitfall\n  scope:\n    - \"src/**\"\n  source:\n    type: docs\n    ref: CONTRIBUTING.md\n  evidence: docs\n  one_line: \"" + oneLine + "\"\n  checks: []\n  status: active\n  created: 2026-11-03\n---\n" + oneLine + "\n"
		p := filepath.Join(learned, "mx_wtreep.md")
		os.WriteFile(p, []byte(body), 0o600)
		past := time.Now().Add(-5 * time.Second)
		os.Chtimes(p, past, past)
	}
	os.WriteFile(filepath.Join(main, "src", "a.ts"), []byte("a"), 0o600)
	gitRun(main, "add", ".")
	gitRun(main, "commit", "-q", "-m", "init")
	tree := filepath.Join(parent, "tree")
	gitRun(main, "worktree", "add", "-q", "--detach", tree)
	entry(main, "Main checkout wording.")
	entry(tree, "Worktree wording.")
	register(t, h, main, projectID, "on", "")
	register(t, h, tree, projectID, "on", "")

	// The main checkout's verdict says broken; the worktree has none.
	hooks, err := localrecord.OpenHooks(localrecord.Location{Directory: h.mex, Hooks: filepath.Join(h.mex, "hooks.db")})
	if err != nil {
		t.Fatal(err)
	}
	mainReal, _ := place.RealPath(main)
	hooks.PutVerdicts(projectID, mainReal, []localrecord.Verdict{{EntryID: "mx_wtreep", Verdict: "broken", InputsHash: "x", CheckedAt: "2026-11-14T00:00:00Z"}})
	hooks.Close()

	batch := func(root string) string {
		file := filepath.Join(root, "src", "a.ts")
		b, _ := json.Marshal(map[string]any{"session_id": "wt", "cwd": main, "hook_event_name": "PostToolBatch", "tool_calls": []any{map[string]any{"tool_name": "Read", "tool_input": map[string]any{"file_path": file}, "tool_use_id": "1", "tool_response": "1\ta"}}})
		_, out := run(t, []string{"claude-code", "PostToolBatch"}, bytes.NewReader(b), env)
		return out
	}
	// The shell is in the main checkout, but the file is in the worktree.
	if out := batch(tree); !strings.Contains(out, "Worktree wording.") || strings.Contains(out, "Main checkout") {
		t.Fatalf("worktree read: %s", out)
	}
	if out := batch(main); strings.Contains(out, "wording") {
		t.Fatalf("main checkout's broken verdict ignored: %s", out)
	}
}
