package hook

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/check"
	"github.com/mex-memory/mex/native/delivery/entries"
	localrecord "github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
)

// A session starts on clean code, then the code a learned rule's fix points to
// changes on disk with no tool event in between. The next matching edit must
// not get the rule's claim or fix from the hold cached at session start.
func TestSameSessionLearnedFixFreshness(t *testing.T) {
	const (
		id     = "mx_deepaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		rel    = "src/types.ts"
		claim  = "Keep request types independent of the runtime."
		why    = "This package supports multiple runtimes."
		quote  = "Keep the core runtime independent."
		fix    = "export type Env = { value: string }"
		anti   = "runtimeContext?: unknown"
		clean  = fix + "\n"
		before = "export type Env = { " + anti + " }"
		url    = "https://github.com/example/project/pull/12#discussion_r42"
	)
	digest := func(s string) string { return fmt.Sprintf("sha256:%x", sha256.Sum256([]byte(s))) }
	for _, agent := range []string{"claude-code", "codex"} {
		for _, level := range []string{"personal", "team"} {
			// broad: the rule covers a folder and the edit creates a new file
			// in it, so no file on disk is the edit's own. The scope is then
			// proven from a path the index lists that is still on disk.
			for _, breadth := range []string{"exact", "broad"} {
				t.Run(agent+"/"+level+"/"+breadth, func(t *testing.T) {
					glob, target := rel, rel
					if breadth == "broad" {
						glob, target = "src/**", "src/runtime.ts"
					}
					h, env := fakeHome(t, true)
					root, err := place.RealPath(repo(t, t.TempDir()))
					if err != nil {
						t.Fatal(err)
					}
					register(t, h, root, projectID, "on", "")
					loc := hooksLocation(h, h.recordDirectory())
					prepareBriefStore(t, loc)
					file := filepath.Join(root, filepath.FromSlash(rel))
					write(t, file, clean)
					fakeIndex(t, loc.Directory, projectID, root, rel, []byte(clean), nil)
					db, err := sql.Open("sqlite", filepath.Join(loc.Directory, "record.db"))
					if err != nil {
						t.Fatal(err)
					}
					_, err = db.Exec("CREATE TABLE settings(scope,key,value); INSERT INTO settings VALUES(?,?,?)", projectID,
						fmt.Sprintf("learning.deep.url.%x", sha256.Sum256([]byte(url+"\n"+digest(quote)))),
						fmt.Sprintf(`{"state":"same","at":%q}`, time.Now().UTC().Format(time.RFC3339Nano)))
					db.Close()
					if err != nil {
						t.Fatal(err)
					}
					producer := ""
					if level == "personal" {
						producer = fmt.Sprintf(", producer: learn-deeper, quote: %q", quote)
					}
					entry := fmt.Sprintf(`---
mex:
  id: %s
  kind: rule
  scope: [%q]
  source: {type: review, ref: %q%s}
  evidence: review
  one_line: %q
  when: [{type: anti, match: literal, pattern: %q}]
  checks:
    - kind: scope
      role: complete
      target: {glob: %q}
      saw: {count: 1}
      files: {}
    - kind: pattern
      role: complete
      target: {scope: %s, pattern: "export type Env = {", match: literal, expect: present}
      saw: {count: 1}
      files: {}
    - kind: source
      role: supporting
      target: {url: %q}
      saw: {hash: %q}
      files: {}
    - kind: fixture
      role: complete
      target:
        pairs:
          - path: %s
            commit: '%s'
            before: {start: 1, end: 1, text: %q, hash: %q}
            after: {start: 1, end: 1, text: %q, hash: %q}
        proves: [0]
      saw: {ok: true}
      files: {}
  fix: {snippet: %q, path: %s, commit: '%s', lines: '1-1'}
  status: active
  created: 2026-11-23
---
%s %s
`, id, glob, url, producer, claim, anti, glob, rel, url, digest(quote), rel, strings.Repeat("a", 40),
						before, digest(before), fix, digest(fix), fix, rel, strings.Repeat("a", 40), claim, why)
					if _, err := entries.Parse([]byte(entry)); err != nil {
						t.Fatal(err)
					}
					dir := filepath.Join(root, ".mex", "learned")
					if level == "personal" {
						dir = filepath.Join(h.mex, "projects", projectID, "notes")
					}
					write(t, filepath.Join(dir, id+".md"), entry)
					hook := func(event, session string, fields map[string]any) string {
						t.Helper()
						fields["session_id"], fields["cwd"], fields["hook_event_name"] = session, root, event
						if agent == "codex" && event == "PreToolUse" {
							fields["turn_id"], fields["tool_use_id"] = session+"-turn", session+"-tool"
						}
						payload, err := json.Marshal(fields)
						if err != nil {
							t.Fatal(err)
						}
						code, out := run(t, []string{agent, event}, bytes.NewReader(payload), env)
						if code != 0 {
							t.Fatalf("%s exited %d: %s", event, code, out)
						}
						return out
					}
					cached := func() localrecord.Verdict {
						t.Helper()
						db, err := localrecord.OpenHooks(loc)
						if err != nil {
							t.Fatal(err)
						}
						defer db.Close()
						v, found, err := db.VerdictOf(projectID, root, id)
						if err != nil || !found || v.Verdict != check.Held || !strings.HasPrefix(v.InputsHash, "sha256:") {
							t.Fatalf("expected a cached check-stage hold: %+v, %v, %v", v, found, err)
						}
						return v
					}
					edited := filepath.Join(root, filepath.FromSlash(target))
					edit := map[string]any{"tool_name": "Edit", "tool_input": map[string]any{
						"file_path": edited, "old_string": "// placeholder", "new_string": anti,
					}}
					patch := fmt.Sprintf("*** Begin Patch\n*** Update File: %s\n@@\n-// placeholder\n+%s\n*** End Patch", filepath.ToSlash(edited), anti)
					if breadth == "broad" {
						edit = map[string]any{"tool_name": "Write", "tool_input": map[string]any{"file_path": edited, "content": anti + "\n"}}
						patch = fmt.Sprintf("*** Begin Patch\n*** Add File: %s\n+%s\n*** End Patch", filepath.ToSlash(edited), anti)
					}
					if agent == "codex" {
						edit = map[string]any{"tool_name": "apply_patch", "tool_input": map[string]any{"command": patch}}
					}
					for _, tc := range []struct {
						name    string
						change  func()
						deny    bool
						pointer bool
					}{
						{"unrelated", func() { write(t, filepath.Join(root, "README.md"), "An external edit.\n") }, true, false},
						{"target still holds", func() { write(t, file, clean+"// A harmless change.\n") }, true, false},
						{"target changed", func() {
							info, err := os.Stat(file)
							if err != nil {
								t.Fatal(err)
							}
							// Neither size nor mtime changes. The current bytes decide.
							write(t, file, strings.Replace(clean, "Env", "Ctx", 1))
							if err := os.Chtimes(file, info.ModTime(), info.ModTime()); err != nil {
								t.Fatal(err)
							}
						}, false, false},
						{"target too large to re-read", func() {
							// The pattern still holds, but the file is past what a hook
							// reads: freshness can't be shown, so only the pointer goes.
							write(t, file, clean+strings.Repeat("// padding\n", 32<<10))
						}, false, true},
					} {
						t.Run(tc.name, func(t *testing.T) {
							write(t, file, clean)
							hook("SessionStart", tc.name, map[string]any{"source": "startup"})
							initial := cached()
							tc.change()
							if after := cached(); after != initial {
								t.Fatalf("the external edit refreshed the cached verdict: %+v", after)
							}
							out := hook("PreToolUse", tc.name, edit)
							r := parseClaude(t, out).HookSpecificOutput
							switch {
							case tc.deny:
								if r.PermissionDecision != "deny" || !strings.Contains(r.PermissionDecisionReason, claim) || !strings.Contains(r.PermissionDecisionReason, fix) {
									t.Fatalf("expected the edit to stop with the current claim and fix: %s", out)
								}
							case r.PermissionDecision == "deny" || strings.Contains(out, claim) || strings.Contains(out, why) || strings.Contains(out, fix) || strings.Contains(out, quote):
								t.Fatalf("stale learned text reached the agent: %s", out)
							case tc.pointer && !strings.Contains(out, "mex recall "+id):
								t.Fatalf("an unproven hold should leave the pointer: %s", out)
							}
							t.Logf("PreToolUse reply %s", out)
						})
					}
				})
			}
		}
	}
}
