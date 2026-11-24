package hook

import (
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/check"
	"github.com/mex-memory/mex/native/delivery"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/internal/shellparse"
	localrecord "github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
)

// Time the hook gives the free stage before handing the rest to a detached
// run. Most runs reuse cached verdicts and finish in a few milliseconds.
var (
	stageBudgetStart = 400 * time.Millisecond
	stageBudgetGit   = 250 * time.Millisecond
	stageBudgetEdit  = 100 * time.Millisecond
	// A detached run still stops, so a stuck file system can't keep it alive.
	stageBudgetDetached = 30 * time.Second
)

// gitMoves are git commands after which many files can differ.
var gitMoves = map[string]bool{"pull": true, "checkout": true, "switch": true, "merge": true, "rebase": true, "reset": true, "cherry-pick": true, "revert": true, "am": true, "stash": true, "restore": true}

// maxStageReads bounds the files one shell command's reads re-check.
const maxStageReads = 8

// stageTrigger says whether this event should run the free stage: every
// entry (paths nil) or only those reading the edited or read files.
//
// A read re-checks the entries on that file because the file can change
// outside any edit tool: a shell command, a formatter, the person's editor.
// The stage runs before delivery, so the read's own moment sees the new
// verdict. Unchanged inputs reuse the cached verdict. readsOnly says the
// paths come from reads alone, which the caller filters cheaply first.
func stageTrigger(ev contract.Event) (run bool, paths []string, budget time.Duration, readsOnly bool) {
	switch ev.Kind {
	case contract.SessionStart:
		return true, nil, stageBudgetStart, false
	case contract.PostTool, contract.PostToolBatch:
		tools := ev.Batch
		if ev.Tool != nil {
			tools = []contract.Tool{*ev.Tool}
		}
		readsOnly = true
		seen := map[string]bool{}
		add := func(p string) {
			if p == "" {
				return
			}
			if rel, ok := place.RelativeToCheckout(ev.Checkout, p); ok {
				if rel = filepath.ToSlash(rel); !seen[rel] {
					seen[rel] = true
					paths = append(paths, rel)
				}
			}
		}
		for _, tool := range tools {
			if tool.Output == nil || !tool.Output.OK {
				continue
			}
			switch tool.Name {
			case contract.ToolShell:
				if movesGit(tool.Input.Command) {
					return true, nil, stageBudgetGit, false
				}
				for i, r := range shellparse.Reads(tool.Input.Command, ev.Cwd, ev.Agent == "codex") {
					if i >= maxStageReads {
						break
					}
					add(r.Path)
				}
			case contract.ToolRead:
				add(tool.Input.Path)
			default:
				for _, edit := range editsOf(tool) {
					readsOnly = false
					add(edit.path)
				}
			}
		}
		return len(paths) > 0, paths, stageBudgetEdit, readsOnly
	}
	return false, nil, 0, false
}

// movesGit reports a git command that can change many files at once.
func movesGit(command string) bool {
	for _, segment := range shellparse.Segments(command) {
		words := shellparse.Words(segment)
		for i := 0; i < 1 && i < len(words); i++ {
			if strings.ToLower(strings.TrimSuffix(path.Base(strings.ReplaceAll(words[i], `\`, "/")), ".exe")) != "git" {
				continue
			}
			// Skip global options like -C <dir> or -c key=value.
			for j := i + 1; j < len(words); j++ {
				w := words[j]
				if w == "-C" || w == "-c" || w == "--git-dir" || w == "--work-tree" {
					j++
					continue
				}
				if strings.HasPrefix(w, "-") {
					continue
				}
				if gitMoves[w] {
					return true
				}
				break
			}
		}
	}
	return false
}

func hooksLocation(h home, recordDirectory string) localrecord.Location {
	return localrecord.Location{Home: h.mex, Directory: recordDirectory, Record: filepath.Join(recordDirectory, "record.db"), Hooks: filepath.Join(recordDirectory, "hooks.db")}
}

// freeStage re-checks entries whose inputs changed and stores their
// verdicts. Every error is ignored; whatever is left when the budget runs
// out goes to a detached run. A store failure leaves a host-bound request so
// the background evaluator can retry without spending inside the hook.
func freeStage(ev contract.Event, h home, recordDirectory string) {
	if recordDirectory == "" || ev.ProjectID == "" || ev.Checkout == "" {
		return
	}
	run, paths, budget, readsOnly := stageTrigger(ev)
	if !run {
		return
	}
	// Most reads touch no entry: skip the database and the evaluator.
	if readsOnly && !check.ReadTouchesEntries(check.StageOptions{Checkout: ev.Checkout, ProjectID: ev.ProjectID, MexHome: h.mex, RecordDirectory: recordDirectory, Paths: paths}) {
		return
	}
	// A read changes no code, so it never asks for the judge (a model job);
	// edits, git moves and session starts still do.
	judge := func() {
		if !readsOnly {
			requestJudge(ev, recordDirectory, paths)
		}
	}
	hooks, err := localrecord.OpenHooks(hooksLocation(h, recordDirectory))
	if err != nil {
		judge()
		return
	}
	defer hooks.Close()
	report, err := check.RunStage(check.StageOptions{
		Checkout: ev.Checkout, ProjectID: ev.ProjectID, MexHome: h.mex, RecordDirectory: recordDirectory,
		Store: hooks, Paths: paths, Deadline: time.Now().Add(budget),
	})
	if err != nil || needsJudge(report) {
		judge()
	}
	if err == nil {
		rebuildOnFlip(report, recordDirectory, ev.ProjectID, ev.Checkout)
	}
	if err == nil && report.Unfinished && takeStageLock(recordDirectory, ev.Checkout, time.Now()) && !startDetachedStage(ev.ProjectID, ev.Checkout) {
		_ = os.Remove(stageLockPath(recordDirectory, ev.Checkout))
	}
}

// stageLockPath marks a detached run in progress for one checkout, so a
// burst of hooks that each run out of budget starts one run, not many.
func stageLockPath(recordDirectory, checkout string) string {
	return strings.TrimSuffix(check.EntryCachePath(recordDirectory, checkout), ".json") + ".stage"
}

// takeStageLock claims the detached run. A lock older than a detached run
// can last belongs to a run that died, and is taken over.
func takeStageLock(recordDirectory, checkout string, now time.Time) bool {
	lock := stageLockPath(recordDirectory, checkout)
	if err := os.MkdirAll(filepath.Dir(lock), 0o700); err != nil {
		return false
	}
	for try := 0; try < 2; try++ {
		file, err := os.OpenFile(lock, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err == nil {
			_ = file.Close()
			return true
		}
		info, statErr := os.Stat(lock)
		if statErr != nil || now.Sub(info.ModTime()) < stageBudgetDetached+10*time.Second {
			return false
		}
		_ = os.Remove(lock)
	}
	return false
}

// startDetachedStage runs `mex-hook --check-stage` in the background and
// says whether it started.
var startDetachedStage = func(projectID, checkout string) bool {
	self, err := os.Executable()
	if err != nil {
		return false
	}
	cmd := exec.Command(self, "--check-stage", projectID, checkout)
	cmd.Dir = checkout
	detach(cmd)
	if cmd.Start() != nil {
		return false
	}
	_ = cmd.Process.Release()
	return true
}

// checkStage is `mex-hook --check-stage <project> <checkout>`: one full run
// of the free stage with a long budget. Always exits 0.
func checkStage(args []string, getenv Env) int {
	if len(args) != 2 {
		return 0
	}
	h := homeFrom(getenv)
	if !h.mexInstalled() {
		return 0
	}
	recordDirectory := h.recordDirectory()
	if recordDirectory == "" {
		return 0
	}
	defer os.Remove(stageLockPath(recordDirectory, args[1]))
	hooks, err := localrecord.OpenHooks(hooksLocation(h, recordDirectory))
	if err != nil {
		return 0
	}
	defer hooks.Close()
	_, stageErr := check.RunStage(check.StageOptions{
		Checkout: args[1], ProjectID: args[0], MexHome: h.mex, RecordDirectory: recordDirectory,
		Store: hooks, Deadline: time.Now().Add(stageBudgetDetached),
	})
	if stageErr == nil {
		// The original hook already left the host-specific judge request.
		startBackground(h, recordDirectory)
	}
	return 0
}

// rebuildOnFlip asks the background process to rebuild MEX's rule files when
// a check flipped an entry's verdict, so a rule file never keeps a line the
// code stopped supporting (or leaves out one it supports again) until some
// later session start notices. The person's own files are rewritten at once;
// shared ones wait for the session to end.
func rebuildOnFlip(report check.StageReport, recordDirectory, projectID, checkout string) {
	if len(report.Flipped) > 0 && recordDirectory != "" && projectID != "" && checkout != "" {
		_ = delivery.RequestNativeRebuild(recordDirectory, projectID, checkout)
	}
}
