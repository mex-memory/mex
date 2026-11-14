package hook

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/check"
	localrecord "github.com/mex-memory/mex/native/record"
)

func TestMovesGit(t *testing.T) {
	for command, want := range map[string]bool{
		"git pull --rebase":                                    true,
		"git -C ../other checkout main":                        true,
		"npm test && git switch -c feature":                    true,
		`"C:\Program Files\Git\bin\git.exe" merge origin/next`: true,
		"git status --short":                                   false,
		"git log --oneline -3":                                 false,
		"echo git checkout":                                    false,
		"gitk":                                                 false,
	} {
		if got := movesGit(command); got != want {
			t.Errorf("%q: %v", command, got)
		}
	}
}

func posted(tool string, input map[string]any, cwd string) string {
	b, _ := json.Marshal(map[string]any{"session_id": "s1", "hook_event_name": "PostToolUse", "cwd": cwd, "tool_name": tool, "tool_input": input, "tool_response": map[string]any{"stdout": "", "stderr": "", "interrupted": false}})
	return string(b)
}

// The free stage runs from the hook: at session start, after an edit, after
// a git checkout. Verdicts land in hooks.db.
func TestHookRunsTheFreeStage(t *testing.T) {
	h, env := fakeHome(t, true)
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "on", "")
	write(t, filepath.Join(root, "package.json"), `{"scripts":{"test":"tsc && vitest"}}`)
	ev, err := check.NewEvaluator(root)
	if err != nil {
		t.Fatal(err)
	}
	c, err := ev.Record("key", check.Complete, map[string]any{"file": "package.json", "pointer": "/scripts/test"})
	ev.Close()
	if err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(root, ".mex", "learned", "mx_script.md"), "---\nmex:\n  id: mx_script\n  kind: recipe\n  scope: [\"**\"]\n  source: {type: config, ref: package.json}\n  evidence: mined\n  one_line: x\n  checks:\n    - kind: key\n      role: complete\n      target: {file: package.json, pointer: /scripts/test}\n      saw: {value: \"tsc && vitest\"}\n      files: {package.json: \""+c.Files["package.json"]+"\"}\n  status: active\n  created: 2026-11-14\n---\nText.\n")
	// Create hooks.db first, as session setup does: a cold migration may not
	// fit a hook's short write budget, and the hook then skips the stage.
	if hooks, err := localrecord.OpenHooks(hooksLocation(h, h.mex)); err == nil {
		hooks.Close()
	}
	detached := 0
	saved := startDetachedStage
	startDetachedStage = func(string, string) { detached++ }
	t.Cleanup(func() { startDetachedStage = saved })

	// Reads use the hook's short budget, so retry on a loaded machine.
	verdict := func() string {
		t.Helper()
		found, _ := findCheckout(h.mex, root, false, time.Now())
		var err error
		for try := 0; try < 50; try++ {
			var hooks *localrecord.Hooks
			if hooks, err = localrecord.OpenHooks(hooksLocation(h, h.mex)); err != nil {
				time.Sleep(20 * time.Millisecond)
				continue
			}
			var all map[string]localrecord.Verdict
			all, err = hooks.Verdicts(projectID, found.Root)
			hooks.Close()
			if err != nil {
				time.Sleep(20 * time.Millisecond)
				continue
			}
			for _, v := range all {
				return v.Verdict
			}
			return ""
		}
		t.Fatal(err)
		return ""
	}

	run(t, []string{"claude-code", "SessionStart"}, strings.NewReader(sessionStart(root)), env)
	if got := verdict(); got != check.Held {
		t.Fatalf("session start: %q", got)
	}

	write(t, filepath.Join(root, "package.json"), `{"scripts":{"test":"vitest"}}`)
	run(t, []string{"claude-code", "PostToolUse"}, strings.NewReader(posted("Edit", map[string]any{"file_path": filepath.Join(root, "package.json"), "old_string": "tsc && vitest", "new_string": "vitest"}, root)), env)
	if got := verdict(); got != check.Broken {
		t.Fatalf("after the edit: %q", got)
	}

	write(t, filepath.Join(root, "package.json"), `{"scripts":{"test":"tsc && vitest"}}`)
	run(t, []string{"claude-code", "PostToolUse"}, strings.NewReader(posted("Bash", map[string]any{"command": "git status"}, root)), env)
	if got := verdict(); got != check.Broken {
		t.Fatalf("a read-only git command re-ran the stage: %q", got)
	}
	run(t, []string{"claude-code", "PostToolUse"}, strings.NewReader(posted("Bash", map[string]any{"command": "git checkout main"}, root)), env)
	if got := verdict(); got != check.Held {
		t.Fatalf("after checkout: %q", got)
	}
	if detached != 0 {
		t.Fatalf("detached %d times", detached)
	}

	// Out of budget: the rest goes to a detached run.
	savedBudget := stageBudgetStart
	stageBudgetStart = -time.Second
	t.Cleanup(func() { stageBudgetStart = savedBudget })
	write(t, filepath.Join(root, "package.json"), `{"scripts":{"test":"jest"}}`)
	run(t, []string{"claude-code", "SessionStart"}, strings.NewReader(sessionStart(root)), env)
	if detached != 1 || verdict() != check.Held {
		t.Fatalf("budget: detached %d", detached)
	}
	// The detached run finishes it.
	found, _ := findCheckout(h.mex, root, false, time.Now())
	checkStage([]string{projectID, found.Root}, env)
	if got := verdict(); got != check.Broken {
		t.Fatalf("detached run: %q", got)
	}
}
