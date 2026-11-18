package hook

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	localrecord "github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/workset"
)

// prepareBriefStore installs the real migrations outside a hook deadline, so
// tests exercise delivery from an installed store, not cold DDL latency.
func prepareBriefStore(t *testing.T, location localrecord.Location) {
	t.Helper()
	if err := localrecord.PrepareHooks(location); err != nil {
		t.Fatal(err)
	}
}

func TestSessionStartDeliversCheckedBriefAndResumeDoesNotResend(t *testing.T) {
	for _, agent := range []string{"claude-code", "codex"} {
		t.Run(agent, func(t *testing.T) {
			h, env := fakeHome(t, true)
			root := repo(t, t.TempDir())
			register(t, h, root, projectID, "on", "")
			prepareStore(t, h)
			write(t, filepath.Join(root, ".mex/learned/mx_rule01.md"), "---\nmex:\n  id: mx_rule01\n  kind: rule\n  scope: ['**']\n  source: {type: docs, ref: README.md}\n  evidence: docs\n  one_line: Small commits review faster.\n  checks: []\n  status: active\n  created: 2026-11-15\n---\nSmall commits review faster.\n")
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

// Notes no rule file carries (just saved, or Codex where AGENTS.md is the
// person's own) all reach a new session: the start lane, shared with the
// carry block, used to let one through.
func TestSessionStartDeliversEveryNoteNoRuleFileCarries(t *testing.T) {
	for _, agent := range []string{"claude-code", "codex"} {
		t.Run(agent, func(t *testing.T) {
			h, env := fakeHome(t, true)
			root := repo(t, t.TempDir())
			register(t, h, root, projectID, "on", "")
			prepareStore(t, h)
			for i := 0; i < 5; i++ {
				id := fmt.Sprintf("mx_note%02d", i)
				write(t, filepath.Join(h.mex, "projects", projectID, "notes", id+".md"), "---\nmex:\n  id: "+id+"\n  kind: rule\n  scope:\n    - \"**\"\n  source:\n    type: person\n    ref: mex note 2026-11-18\n    quote: Note "+id+" says deploys go from the release branch, after QA.\n  evidence: person\n  one_line: Note "+id+" says deploys go from the release branch, after QA.\n  checks: []\n  status: active\n  created: 2026-11-18\n---\nNote "+id+" says deploys go from the release branch, after QA.\n")
			}
			payload, _ := json.Marshal(map[string]any{"session_id": "notes-session", "hook_event_name": "SessionStart", "source": "startup", "cwd": root})
			code, out := run(t, []string{agent, "SessionStart"}, strings.NewReader(string(payload)), env)
			if code != 0 {
				t.Fatal(code)
			}
			for i := 0; i < 5; i++ {
				if !strings.Contains(out, fmt.Sprintf("mx_note%02d", i)) {
					t.Fatal(out)
				}
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

func TestSessionStartChoosesByWorkingSetAndAsksForAFreshOne(t *testing.T) {
	h, env := fakeHome(t, true)
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "on", "")
	prepareStore(t, h)
	rule := func(id, scope, line string) {
		write(t, filepath.Join(root, ".mex/learned/"+id+".md"), "---\nmex:\n  id: "+id+"\n  kind: rule\n  scope: ['"+scope+"']\n  source: {type: docs, ref: README.md}\n  evidence: docs\n  one_line: "+line+"\n  checks: []\n  status: active\n  created: 2026-11-15\n---\n"+line+"\n")
	}
	rule("mx_seedrl", "src/pay.ts", "Retry payments twice.")
	rule("mx_glob01", "**", "Global one.")
	rule("mx_glob02", "**", "Global two.")
	rule("mx_glob03", "**", "Global three.")
	directory := h.recordDirectory()
	cache, err := workset.Path(directory, projectID, root)
	if err != nil {
		t.Fatal(err)
	}
	set := func(made time.Time) {
		body, _ := json.Marshal(workset.Set{Version: 1, Made: made.UTC().Format(time.RFC3339Nano), Seeds: []string{"src/pay.ts"}})
		write(t, cache, string(body))
	}
	set(time.Now())
	choice := "on"
	start := func(session string) string {
		payload, _ := json.Marshal(map[string]any{"session_id": session, "hook_event_name": "SessionStart", "source": "startup", "cwd": root})
		forced := func(k string) string {
			if k == "MEX_DELIVERY_SURFACES" {
				return `{"start-brief-working-set":"` + choice + `"}`
			}
			return env(k)
		}
		code, out := run(t, []string{"claude-code", "SessionStart"}, strings.NewReader(string(payload)), forced)
		if code != 0 {
			t.Fatal(code)
		}
		return out
	}
	out := start("ws-1")
	if !strings.Contains(out, "Retry payments twice.") || !strings.Contains(out, "Global one.") || strings.Contains(out, "Global three.") {
		t.Fatal(out)
	}
	db, err := sql.Open("sqlite", filepath.Join(directory, "hooks.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var action, surface string
	if err = db.QueryRow(`SELECT action,surface FROM deliveries WHERE entry_id='mx_glob03'`).Scan(&action, &surface); err != nil || action != "shadow" || surface != "start-brief" {
		t.Fatal("the folder pick was not kept for comparison", action, surface, err)
	}
	// The other arm sends the folder choice and keeps the working-set one.
	choice = "shadow"
	if out := start("ws-folder"); !strings.Contains(out, "Global three.") || strings.Contains(out, "Retry payments twice.") {
		t.Fatal(out)
	}
	if err = db.QueryRow(`SELECT action,surface FROM deliveries WHERE entry_id='mx_seedrl' AND session_id='ws-folder'`).Scan(&action, &surface); err != nil || action != "shadow" || surface != "start-brief-working-set" {
		t.Fatal("the working-set pick was not kept for comparison", action, surface, err)
	}
	choice = "trial"
	if _, err = os.Stat(workset.PendingMarker(directory)); !os.IsNotExist(err) {
		t.Fatal("a fresh working set asked for a refresh")
	}
	set(time.Now().Add(-time.Hour))
	start("ws-2")
	if _, err = os.Stat(workset.PendingMarker(directory)); err != nil {
		t.Fatal("an old working set didn't ask for a refresh")
	}
}
