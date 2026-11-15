package hook

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	localrecord "github.com/mex-memory/mex/native/record"
)

func TestSessionStartDeliversCheckedBriefAndResumeDoesNotResend(t *testing.T) {
	for _, agent := range []string{"claude-code", "codex"} {
		t.Run(agent, func(t *testing.T) {
			h, env := fakeHome(t, true)
			root := repo(t, t.TempDir())
			register(t, h, root, projectID, "on", "")
			prepareStore(t, h)
			write(t, filepath.Join(root, ".mex/learned/mx_rule01.md"), "---\nmex:\n  id: mx_rule01\n  kind: rule\n  scope: ['**']\n  source: {type: docs, ref: README.md}\n  evidence: docs\n  one_line: Small commits review faster.\n  checks: []\n  status: active\n  created: 2026-11-15\n---\nSmall commits review faster.\n")
			// Warm the store just as machine installation does.
			hooks, err := localrecord.OpenHooks(hooksLocation(h, h.mex))
			if err != nil {
				t.Fatal(err)
			}
			hooks.Close()
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
