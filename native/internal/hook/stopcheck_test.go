package hook

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	localrecord "github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
)

const stopProofCommand = "npm run -w packages/api test"

func seedStopProof(t *testing.T, h home, root, agent, session string) {
	t.Helper()
	const entryID = "mx_stopproof"
	hooks := seedStopEntry(t, h, root, entryID, `---
mex:
  id: `+entryID+`
  kind: procedure
  scope:
    - "packages/api/**"
  source:
    type: ci
    ref: .github/workflows/api.yml
  evidence: mined
  one_line: "Run `+stopProofCommand+` after changes in packages/api/**."
  checks:
    - kind: key
      role: complete
      target: {file: .github/workflows/api.yml, pointer: /on/pull_request/paths}
      saw: {value: ["packages/api/**"]}
      files: {}
    - kind: command
      role: supporting
      target: {run: "`+stopProofCommand+`", file: packages/api/package.json, pointer: /scripts/test}
      saw: {exists: true}
      files: {}
  status: active
  created: 2026-11-03
---
Run the API test command for changes under packages/api.
`)
	appendStopEdit(t, hooks, localrecord.Session{SessionID: session, Agent: agent, ProjectID: projectID, Checkout: root}, "packages/api/src/routes.ts")
}

func seedStopEntry(t *testing.T, h home, root, entryID, body string) *localrecord.Hooks {
	t.Helper()
	write(t, filepath.Join(root, ".mex", "learned", entryID+".md"), body)
	loc := localrecord.Location{Directory: h.mex, Hooks: filepath.Join(h.mex, "hooks.db")}
	if err := localrecord.PrepareHooks(loc); err != nil {
		t.Fatal(err)
	}
	hooks, err := localrecord.OpenHooks(loc)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := hooks.Close(); err != nil {
			t.Error(err)
		}
	})
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if err := hooks.PutVerdicts(projectID, root, []localrecord.Verdict{{EntryID: entryID, Verdict: "held", InputsHash: "x", CheckedAt: now}}); err != nil {
		t.Fatal(err)
	}
	return hooks
}

func appendStopEdit(t *testing.T, hooks *localrecord.Hooks, session localrecord.Session, file string) {
	t.Helper()
	now := time.Now().UTC().Format(time.RFC3339Nano)
	if err := hooks.AppendJournal(session, now, []localrecord.JournalRow{{Kind: "edit", Text: file}}); err != nil {
		t.Fatal(err)
	}
}

func TestStopProofThroughTheHook(t *testing.T) {
	cases := []struct {
		name, agent, event string
		stopActive         bool
		disabled           bool
		block              bool
	}{
		{name: "Claude Code blocks for a missed obligation", agent: "claude-code", event: "Stop", block: true},
		{name: "Claude Code already continuing", agent: "claude-code", event: "Stop", stopActive: true},
		{name: "Stop checks disabled", agent: "claude-code", event: "Stop", disabled: true},
		{name: "Kiro cannot deny at Stop", agent: "kiro", event: "stop"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h, env := fakeHome(t, true)
			root, err := place.RealPath(repo(t, t.TempDir()))
			if err != nil {
				t.Fatal(err)
			}
			register(t, h, root, projectID, "on", "")
			const session = "stop-proof"
			seedStopProof(t, h, root, c.agent, session)
			if c.disabled {
				env = withEnv(env, map[string]string{"MEX_STOP_CHECKS": "0"})
			}
			payload, err := json.Marshal(map[string]any{
				"session_id":       session,
				"cwd":              root,
				"hook_event_name":  c.event,
				"stop_hook_active": c.stopActive,
			})
			if err != nil {
				t.Fatal(err)
			}
			code, out := run(t, []string{c.agent, c.event}, bytes.NewReader(payload), env)
			switch {
			case c.block:
				if code != 0 {
					t.Fatalf("exit code = %d, want 0", code)
				}
				var reply struct {
					Decision string `json:"decision"`
					Reason   string `json:"reason"`
				}
				if err := json.Unmarshal([]byte(out), &reply); err != nil {
					t.Fatalf("reply %q is not valid JSON: %v", out, err)
				}
				if reply.Decision != "block" || !strings.Contains(reply.Reason, stopProofCommand) {
					t.Fatalf("want a block with reason naming %q, got %s", stopProofCommand, out)
				}
			case c.agent == "kiro":
				if code != 0 || out != "" {
					t.Fatalf("want Kiro's silent reply with exit 0, got exit %d and %q", code, out)
				}
			default:
				assertEmptyReply(t, code, out)
			}

			// Kiro's renderer drops denies. The cursor shows whether the hook
			// skipped the check before it reached the renderer.
			if c.disabled || c.agent == "kiro" {
				if _, err := os.Stat(filepath.Join(h.mex, "stop-turn")); !os.IsNotExist(err) {
					t.Fatalf("want no Stop cursor, stat error = %v", err)
				}
			}
		})
	}
}

func TestStopGeneratedFileThroughTheHook(t *testing.T) {
	const (
		entryID    = "mx_stopgen"
		editedFile = "src/gen/api.ts"
	)
	cases := []struct {
		name, agent string
		stopActive  bool
	}{
		{name: "claude-code/sent back once", agent: "claude-code"},
		{name: "claude-code/already continuing", agent: "claude-code", stopActive: true},
		{name: "codex/sent back once", agent: "codex"},
		{name: "codex/already continuing", agent: "codex", stopActive: true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h, env := fakeHome(t, true)
			root, err := place.RealPath(repo(t, t.TempDir()))
			if err != nil {
				t.Fatal(err)
			}
			register(t, h, root, projectID, "on", "")
			file := filepath.Join(root, filepath.FromSlash(editedFile))
			write(t, file, "// DO NOT EDIT\nexport const x = 2\n")
			past := time.Now().Add(-time.Hour)
			if err := os.Chtimes(file, past, past); err != nil {
				t.Fatal(err)
			}
			hooks := seedStopEntry(t, h, root, entryID, `---
mex:
  id: `+entryID+`
  kind: pitfall
  scope:
    - "src/gen/**"
  source:
    type: mined
    ref: "src/gen/**"
  evidence: mined
  one_line: "Files under src/gen/ are generated."
  checks:
    - kind: pattern
      role: supporting
      target: {scope: "src/gen/**", pattern: "DO NOT EDIT", match: literal}
      saw: {count: 1}
      files: {}
  status: active
  created: 2026-11-03
---
Regenerate files under src/gen/ after changing their inputs.
`)
			session := localrecord.Session{SessionID: "stop-generated-file", Agent: c.agent, ProjectID: projectID, Checkout: root}
			appendStopEdit(t, hooks, session, editedFile)

			payload, err := json.Marshal(map[string]any{
				"session_id":       session.SessionID,
				"cwd":              root,
				"hook_event_name":  "Stop",
				"stop_hook_active": c.stopActive,
			})
			if err != nil {
				t.Fatal(err)
			}
			args := []string{c.agent, "Stop"}
			code, out := run(t, args, bytes.NewReader(payload), env)
			if c.stopActive {
				assertEmptyReply(t, code, out)
				return
			}
			if code != 0 {
				t.Fatalf("first Stop exit code = %d, want 0 (reply %q)", code, out)
			}
			var reply struct {
				Decision string `json:"decision"`
				Reason   string `json:"reason"`
			}
			if err := json.Unmarshal([]byte(out), &reply); err != nil {
				t.Fatalf("first Stop reply %q is not valid JSON: %v", out, err)
			}
			if reply.Decision != "block" || !strings.Contains(reply.Reason, "by hand") || !strings.Contains(reply.Reason, entryID) {
				t.Fatalf("want a block with reason naming a hand edit and %q, got %s", entryID, out)
			}

			appendStopEdit(t, hooks, session, editedFile)
			code, out = run(t, args, bytes.NewReader(payload), env)
			assertEmptyReply(t, code, out)
		})
	}
}
