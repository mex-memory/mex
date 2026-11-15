package hook

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	localrecord "github.com/mex-memory/mex/native/record"
)

// Build the fixture from the real migrations outside a hook deadline. This
// tests delivery from an installed store, not cold DDL latency on the runner.
func prepareBriefStore(t *testing.T, location localrecord.Location) {
	t.Helper()
	db, err := sql.Open("sqlite", location.Hooks)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := db.ExecContext(ctx, "PRAGMA journal_mode=WAL"); err != nil {
		t.Fatal(err)
	}
	files, err := filepath.Glob(filepath.Join("..", "..", "record", "schema", "hooks", "*.sql"))
	if err != nil || len(files) != localrecord.SchemaVersion {
		t.Fatalf("fixture migrations: %d files, version %d: %v", len(files), localrecord.SchemaVersion, err)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	for _, file := range files {
		body, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := tx.ExecContext(ctx, string(body)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := tx.ExecContext(ctx, fmt.Sprintf("PRAGMA user_version=%d", localrecord.SchemaVersion)); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

func TestSessionStartDeliversCheckedBriefAndResumeDoesNotResend(t *testing.T) {
	for _, agent := range []string{"claude-code", "codex"} {
		t.Run(agent, func(t *testing.T) {
			h, env := fakeHome(t, true)
			root := repo(t, t.TempDir())
			register(t, h, root, projectID, "on", "")
			write(t, filepath.Join(root, ".mex/learned/mx_rule01.md"), "---\nmex:\n  id: mx_rule01\n  kind: rule\n  scope: ['**']\n  source: {type: docs, ref: README.md}\n  evidence: docs\n  one_line: Small commits review faster.\n  checks: []\n  status: active\n  created: 2026-11-15\n---\nSmall commits review faster.\n")
			prepareBriefStore(t, hooksLocation(h, h.mex))
			invoke := func(source string) string {
				payload, _ := json.Marshal(map[string]any{"session_id": "brief-session", "hook_event_name": "SessionStart", "source": source, "cwd": root})
				code, out := run(t, []string{agent, "SessionStart"}, strings.NewReader(string(payload)), env)
				if code != 0 {
					t.Fatal(code)
				}
				return out
			}
			out := invoke("startup")
			if !strings.Contains(out, "[mex ") || !strings.Contains(out, "Small commits review faster.") {
				t.Fatal(out)
			}
			if out := invoke("resume"); strings.Contains(out, "Priority:") || strings.Contains(out, "Correction:") || strings.Contains(out, "Updated:") {
				t.Fatal("an unchanged brief was resent or treated as changed", out)
			}
			// A new note doesn't change the already delivered start block on resume.
			write(t, filepath.Join(root, ".mex/learned/mx_rule01.md"), "bad entry")
			if out := invoke("resume"); strings.Contains(out, "Priority:") || !strings.Contains(out, "Correction:") {
				t.Fatal(out)
			}
		})
	}
}

func TestBriefPreviewDoesNotCreateTheMexHome(t *testing.T) {
	root := repo(t, t.TempDir())
	data, _ := json.Marshal(map[string]string{"checkout": root, "mex_home": filepath.Join(root, "absent"), "project_id": projectID, "agent": "codex"})
	code, out := run(t, []string{"--brief-run"}, strings.NewReader(string(data)), noEnv)
	if code != 0 || !strings.Contains(out, `"ok":true`) || !strings.Contains(out, "Priority:") {
		t.Fatal(code, out)
	}
	if _, err := os.Stat(filepath.Join(root, "absent")); !os.IsNotExist(err) {
		t.Fatal("preview created storage")
	}
}
