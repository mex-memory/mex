package hook

import (
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/check"
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

// stageTrigger says whether this event should run the free stage: every
// entry (paths nil) or only those reading the edited files.
func stageTrigger(ev contract.Event) (run bool, paths []string, budget time.Duration) {
	switch ev.Kind {
	case contract.SessionStart:
		return true, nil, stageBudgetStart
	case contract.PostTool:
		if ev.Tool == nil || ev.Tool.Output == nil || !ev.Tool.Output.OK {
			return false, nil, 0
		}
		if ev.Tool.Name == contract.ToolShell {
			if movesGit(ev.Tool.Input.Command) {
				return true, nil, stageBudgetGit
			}
			return false, nil, 0
		}
		for _, edit := range editsOf(*ev.Tool) {
			if rel, ok := place.RelativeToCheckout(ev.Checkout, edit.path); ok {
				paths = append(paths, filepath.ToSlash(rel))
			}
		}
		return len(paths) > 0, paths, stageBudgetEdit
	}
	return false, nil, 0
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
// out goes to a detached run.
func freeStage(ev contract.Event, h home, recordDirectory string) {
	if recordDirectory == "" || ev.ProjectID == "" || ev.Checkout == "" {
		return
	}
	run, paths, budget := stageTrigger(ev)
	if !run {
		return
	}
	hooks, err := localrecord.OpenHooks(hooksLocation(h, recordDirectory))
	if err != nil {
		return
	}
	defer hooks.Close()
	report, err := check.RunStage(check.StageOptions{
		Checkout: ev.Checkout, ProjectID: ev.ProjectID, MexHome: h.mex, RecordDirectory: recordDirectory,
		Store: hooks, Paths: paths, Deadline: time.Now().Add(budget),
	})
	if err == nil && report.Unfinished {
		startDetachedStage(ev.ProjectID, ev.Checkout)
	}
}

// startDetachedStage runs `mex-hook --check-stage` in the background.
var startDetachedStage = func(projectID, checkout string) {
	self, err := os.Executable()
	if err != nil {
		return
	}
	cmd := exec.Command(self, "--check-stage", projectID, checkout)
	cmd.Dir = checkout
	detach(cmd)
	if cmd.Start() == nil {
		_ = cmd.Process.Release()
	}
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
	hooks, err := localrecord.OpenHooks(hooksLocation(h, recordDirectory))
	if err != nil {
		return 0
	}
	defer hooks.Close()
	_, _ = check.RunStage(check.StageOptions{
		Checkout: args[1], ProjectID: args[0], MexHome: h.mex, RecordDirectory: recordDirectory,
		Store: hooks, Deadline: time.Now().Add(stageBudgetDetached),
	})
	return 0
}
