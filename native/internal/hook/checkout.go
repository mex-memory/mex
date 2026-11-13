package hook

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record/place"
)

// MEX is on in a checkout once `mex` has registered it and it isn't switched
// off. Checkout lookup does not open SQLite, so Node mirrors each `checkouts`
// row into a small file:
// <record directory>/hook-checkouts/<ShortHash(root)>.json
// (src/record/hook-checkouts.ts writes it).

const hookCheckoutVersion = 1

type hookCheckout struct {
	Version     int    `json:"version"`
	ProjectID   string `json:"project_id"`
	Root        string `json:"root"`
	State       string `json:"state"` // on, off, off until
	OffUntil    string `json:"off_until"`
	Provisional bool   `json:"provisional"`
}

// where says whether MEX is on for a path.
type where int

const (
	// unregistered: `mex` never ran here, or MEX can't tell.
	unregistered where = iota
	// switchedOff: registered, and `mex off` is in force.
	switchedOff
	switchedOn
)

// on reports whether the checkout is on at time now.
func (c hookCheckout) on(now time.Time) bool {
	switch c.State {
	case "on":
		return true
	case "off until":
		until, err := time.Parse(time.RFC3339Nano, c.OffUntil)
		return err == nil && !now.Before(until)
	}
	return false
}

// findCheckout finds the registered checkout holding path (a file when isFile,
// else a folder), the same way Node's RecordWriter.checkout does: walk up from
// the real folder, accept a registration found there, and stop at an
// unregistered nested Git repository. A folder (non-Git) project only covers
// its own folder unless it holds .git.
//
// Resolving links costs a file handle per call on Windows, so the walk first
// tries the path as given, which is usually already the real one, and resolves
// links only when that finds nothing.
func findCheckout(recordDirectory, path string, isFile bool, now time.Time) (hookCheckout, where) {
	if recordDirectory == "" || path == "" {
		return hookCheckout{}, unregistered
	}
	mirror := filepath.Join(recordDirectory, "hook-checkouts")
	start := path
	if isFile {
		start = filepath.Dir(path)
	}
	given, err := place.AbsolutePath(start)
	if err == nil {
		if c, found := walkCheckouts(mirror, given); found {
			return c, c.where(now)
		}
	}
	folder := existingFolder(start)
	if folder == "" {
		return hookCheckout{}, unregistered
	}
	real, err := place.RealPath(folder)
	if err != nil || real == given {
		return hookCheckout{}, unregistered
	}
	if c, found := walkCheckouts(mirror, real); found {
		return c, c.where(now)
	}
	return hookCheckout{}, unregistered
}

// walkCheckouts walks up from requested to the first registration that covers
// it. It stops at an unregistered folder holding .git, and at the root.
func walkCheckouts(mirror, requested string) (hookCheckout, bool) {
	for current := requested; ; {
		if c, ok := readHookCheckout(mirror, current); ok {
			if current == requested || strings.HasPrefix(c.ProjectID, "g-") || c.Provisional || exists(filepath.Join(current, ".git")) {
				return c, true
			}
		}
		if exists(filepath.Join(current, ".git")) {
			return hookCheckout{}, false
		}
		parent := filepath.Dir(current)
		if parent == current {
			return hookCheckout{}, false
		}
		current = parent
	}
}

func (c hookCheckout) where(now time.Time) where {
	if c.on(now) {
		return switchedOn
	}
	return switchedOff
}

func readHookCheckout(mirror, root string) (hookCheckout, bool) {
	data, err := os.ReadFile(filepath.Join(mirror, place.ShortHash(root)+".json"))
	if err != nil {
		return hookCheckout{}, false
	}
	var c hookCheckout
	if json.Unmarshal(data, &c) != nil || c.Version != hookCheckoutVersion || c.Root != root || c.ProjectID == "" {
		return hookCheckout{}, false
	}
	return c, true
}

// existingFolder is the folder to look up for path: the path itself when it is
// a folder, else the nearest existing parent (a file being written may not
// exist yet).
func existingFolder(path string) string {
	for p := filepath.Clean(path); ; {
		if st, err := os.Stat(p); err == nil {
			if st.IsDir() {
				return p
			}
			return filepath.Dir(p)
		}
		parent := filepath.Dir(p)
		if parent == p {
			return ""
		}
		p = parent
	}
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// eventPath is the path that picks the project: the touched file, else the
// shell's folder (contract: "resolved from the touched file, else from cwd").
// isFile is true when the path names a file; a search path may be either, and
// a walk that starts at a file only costs one extra step.
func eventPath(ev contract.Event) (path string, isFile bool) {
	tools := ev.Batch
	if ev.Tool != nil {
		tools = append([]contract.Tool{*ev.Tool}, tools...)
	}
	for _, t := range tools {
		if t.Input.Path != "" {
			return t.Input.Path, t.Name == contract.ToolRead || t.Name == contract.ToolEdit || t.Name == contract.ToolWrite
		}
		for _, f := range t.Input.Files {
			if f.Path != "" {
				return f.Path, true
			}
		}
	}
	return ev.Cwd, false
}

// ---------------------------------------------------------------------------
// The one notice per repo: "MEX is off here. Run `mex` to turn it on."
// ---------------------------------------------------------------------------

const offNotice = "MEX is off here. Run `mex` to turn it on."

// repoRoot is the folder the notice is keyed on: the nearest folder holding
// .git, else the folder itself.
func repoRoot(folder string) string {
	for current := folder; ; {
		if exists(filepath.Join(current, ".git")) {
			return current
		}
		parent := filepath.Dir(current)
		if parent == current {
			return folder
		}
		current = parent
	}
}

// firstOffNotice reports whether this is the first time the notice would show
// for the repo holding cwd, and records that it was shown. Errors mean "don't
// show": a missing notice is better than a repeated one.
func firstOffNotice(recordDirectory, cwd string) bool {
	folder := existingFolder(cwd)
	if recordDirectory == "" || folder == "" {
		return false
	}
	real, err := place.RealPath(folder)
	if err != nil {
		return false
	}
	dir := filepath.Join(recordDirectory, "hook-notices")
	if os.MkdirAll(dir, 0o700) != nil {
		return false
	}
	f, err := os.OpenFile(filepath.Join(dir, "off-"+place.ShortHash(repoRoot(real))), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return false
	}
	_, _ = f.WriteString(repoRoot(real) + "\n")
	_ = f.Close()
	return true
}
