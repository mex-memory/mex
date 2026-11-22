package hook

import (
	"database/sql"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/check"
	"github.com/mex-memory/mex/native/internal/contract"
	localrecord "github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
)

func TestFreeStageRetainsWorkWhenTheHookDatabaseIsBusy(t *testing.T) {
	for _, installed := range []bool{false, true} {
		name := "open"
		if installed {
			name = "write"
		}
		t.Run(name, func(t *testing.T) {
			h, _ := fakeHome(t, true)
			root, err := place.RealPath(repo(t, t.TempDir()))
			if err != nil {
				t.Fatal(err)
			}
			register(t, h, root, projectID, "on", "")
			write(t, filepath.Join(root, "package.json"), `{"scripts":{"test":"old-test"}}`)
			evaluator, err := check.NewEvaluator(root)
			if err != nil {
				t.Fatal(err)
			}
			recorded, err := evaluator.Record("key", check.Complete, map[string]any{"file": "package.json", "pointer": "/scripts/test"})
			evaluator.Close()
			if err != nil {
				t.Fatal(err)
			}
			write(t, filepath.Join(root, ".mex/learned/mx_script.md"), "---\nmex:\n  id: mx_script\n  kind: fact\n  scope: ['**']\n  source: {type: config, ref: package.json}\n  evidence: mined\n  one_line: Tests use old-test.\n  checks:\n    - kind: key\n      role: complete\n      target: {file: package.json, pointer: /scripts/test}\n      saw: {value: old-test}\n      files: {package.json: '"+recorded.Files["package.json"]+"'}\n  status: active\n  created: 2026-11-16\n---\nTests use old-test.\n")
			write(t, filepath.Join(root, "package.json"), `{"scripts":{"test":"new-test"}}`)
			location := hooksLocation(h, h.mex)
			if installed {
				prepareBriefStore(t, location)
			}
			db, err := sql.Open("sqlite", location.Hooks)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			db.SetMaxOpenConns(1)
			if _, err := db.Exec("BEGIN EXCLUSIVE"); err != nil {
				t.Fatal(err)
			}
			defer db.Exec("ROLLBACK")
			// The cold store cannot open. An installed WAL store can read, but cannot
			// persist a newly broken verdict while this other writer holds the lock.
			hooks, openErr := localrecord.OpenHooks(location)
			if installed {
				if openErr != nil {
					t.Fatal(openErr)
				}
				report, stageErr := check.RunStage(check.StageOptions{Checkout: root, ProjectID: projectID, MexHome: h.mex, RecordDirectory: h.mex, Store: hooks})
				hooks.Close()
				if stageErr == nil || report.Counts[check.Broken] != 1 {
					t.Fatalf("expected a blocked verdict write: %+v, %v", report, stageErr)
				}
			} else if openErr == nil {
				hooks.Close()
				t.Fatal("cold store opened through an exclusive lock")
			}
			ev := contract.Event{ProjectID: projectID, Checkout: root, Agent: "claude-code", SessionID: "editing", Kind: contract.PostTool,
				Tool: &contract.Tool{Name: contract.ToolEdit, Input: contract.ToolInput{Path: filepath.Join(root, "package.json")}, Output: &contract.ToolOutput{OK: true}}}
			freeStage(ev, h, h.mex)
			request := judgeRequestAt(t, h.mex, root)
			if request["reason"] != "edit" || request["session_id"] != "editing" || len(request["near"].([]any)) != 1 || request["near"].([]any)[0] != "package.json" {
				t.Fatal(request)
			}
			if request["not_before"].(float64) <= float64(time.Now().UnixMilli()) {
				t.Fatal("lost edit debounce", request)
			}
			ev.Kind = contract.Stop
			if !requestJudge(ev, h.mex, nil) {
				t.Fatal("Stop did not release retained work")
			}
			request = judgeRequestAt(t, h.mex, root)
			if request["reason"] != "idle" || request["not_before"].(float64) > float64(time.Now().UnixMilli()) {
				t.Fatal(request)
			}
		})
	}
}

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
	startDetachedStage = func(string, string) bool { detached++; return true }
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

	// The file changes outside any edit tool (a shell command, the person's
	// editor). A command that neither reads it nor moves git leaves the
	// verdict alone; the next read of the file re-checks it.
	write(t, filepath.Join(root, "package.json"), `{"scripts":{"test":"vitest"}}`)
	run(t, []string{"claude-code", "PostToolUse"}, strings.NewReader(posted("Bash", map[string]any{"command": "npm run lint"}, root)), env)
	if got := verdict(); got != check.Held {
		t.Fatalf("a command that reads no file re-ran the stage: %q", got)
	}
	run(t, []string{"claude-code", "PostToolUse"}, strings.NewReader(posted("Read", map[string]any{"file_path": filepath.Join(root, "package.json")}, root)), env)
	if got := verdict(); got != check.Broken {
		t.Fatalf("after reading the changed file: %q", got)
	}
	write(t, filepath.Join(root, "package.json"), `{"scripts":{"test":"tsc && vitest"}}`)
	run(t, []string{"claude-code", "PostToolUse"}, strings.NewReader(posted("Bash", map[string]any{"command": "cat package.json"}, root)), env)
	if got := verdict(); got != check.Held {
		t.Fatalf("after a shell read of the changed file: %q", got)
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
	// While that run is going, another hook out of budget starts no second one.
	run(t, []string{"claude-code", "SessionStart"}, strings.NewReader(sessionStart(root)), env)
	if detached != 1 {
		t.Fatalf("a second detached run started: %d", detached)
	}
	// The detached run finishes it.
	found, _ := findCheckout(h.mex, root, false, time.Now())
	checkStage([]string{projectID, found.Root}, env)
	if got := verdict(); got != check.Broken {
		t.Fatalf("detached run: %q", got)
	}
	// It released the lock: the next run out of budget can start one.
	if !takeStageLock(h.mex, found.Root, time.Now()) {
		t.Fatal("the detached run kept its lock")
	}
	// A lock left by a run that died is taken over.
	if takeStageLock(h.mex, found.Root, time.Now()) || !takeStageLock(h.mex, found.Root, time.Now().Add(time.Minute)) {
		t.Fatal("stale lock handling")
	}
}
