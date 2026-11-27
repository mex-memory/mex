package delivery

// Stop checks on files: a generated file edited by hand, and a lockfile from
// the wrong package manager (plan sheet 42, layer E). Both read only what
// MEX saw: the journal's edit rows and commands, and the files' times on
// disk. Neither runs a command.

import (
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record"
)

const (
	// stopMaxGenerated bounds the generated-file pitfalls one reason names.
	stopMaxGenerated = 3
	// stopLockfileRule is the budget id of the built-in lockfile check.
	stopLockfileRule = "mex:lockfile"
	// stopMaxPackages bounds the package folders the lockfile check stats.
	stopMaxPackages = 64
	// recipesBytes bounds the setup facts file the lockfile check reads.
	recipesBytes = 4 << 20
)

// ── Generated files ──

// generatedFindings: a generated-file pitfall (knowledge-08: .gitattributes,
// a generated header, or history) whose file the turn edited with an edit
// tool, and that no later command rewrote. A shell command or generator
// changing it is not a hand edit; a command after the edit that left the
// file newer than the edit, or removed it, regenerated or reverted it.
func generatedFindings(ev contract.Event, env Environment, h *record.Hooks, snap *entries.Snapshot, turn stopTurn, state *bumpState) []stopFinding {
	var out []stopFinding
	var full map[string]*entries.Item // loaded once, only for a finding
	for i := range snap.Items {
		it := &snap.Items[i]
		e := it.Entry
		if e == nil || e.Kind != "pitfall" || !it.Generated || it.NeedsHintGate || state.Stopped[e.ID] {
			continue
		}
		var edited []string
		for rel, id := range turn.lastEdit {
			if !inScope(it, rel) || regenerated(ev.Checkout, rel, id, turn) {
				continue
			}
			edited = append(edited, rel)
		}
		if len(edited) == 0 || !supported(h, ev, e) {
			continue
		}
		sort.Strings(edited)
		if full == nil {
			full = map[string]*entries.Item{}
			if loaded, err := entries.Load(env.RecordDirectory, env.Home, ev.ProjectID, ev.Checkout); err == nil {
				for j := range loaded.Items {
					full[loaded.Items[j].Entry.ID] = &loaded.Items[j]
				}
			}
		}
		why := "MEX has it recorded as generated."
		if f := full[e.ID]; f != nil && f.Entry.OneLine != "" {
			why = f.Entry.OneLine
		}
		out = append(out, stopFinding{rule: e.ID, files: edited, line: fmt.Sprintf(
			"You edited %s by hand. %s Undo the hand edit, make the change where the file is generated from, and regenerate it. (%s)",
			namedFiles(edited), why, e.ID)})
		if len(out) == stopMaxGenerated {
			break
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].rule < out[j].rule })
	return out
}

// regenerated: a command ran after the file's last hand edit, and the file
// is now newer than that edit or gone. The edit row is written after the
// edit, so a file newer than it was written again later.
func regenerated(checkout, rel string, editID int64, turn stopTurn) bool {
	if !turn.ranAfter(editID, func(string) bool { return true }) {
		return false
	}
	info, err := os.Stat(filepath.Join(checkout, filepath.FromSlash(rel)))
	if os.IsNotExist(err) {
		return true
	}
	at, ok := turn.lastEditAt[rel]
	return err == nil && ok && info.ModTime().After(at)
}

// ── Lockfiles ──

// lockfiles maps each package manager's lockfile to its manager.
var lockfiles = map[string]string{
	"package-lock.json":   "npm",
	"npm-shrinkwrap.json": "npm",
	"pnpm-lock.yaml":      "pnpm",
	"yarn.lock":           "yarn",
	"bun.lock":            "bun",
	"bun.lockb":           "bun",
}

// installCommand is the command each manager installs with.
var installCommand = map[string]string{"npm": "npm install", "pnpm": "pnpm install", "yarn": "yarn install", "bun": "bun install"}

// setupRecipes is the part of setup's recipes.json (setup facts contract)
// the lockfile check reads.
type setupRecipes struct {
	Version  int    `json:"version"`
	Manager  string `json:"manager"`
	Packages []struct {
		Path string `json:"path"`
		Kind string `json:"kind"`
	} `json:"packages"`
	Review []struct {
		Kind string `json:"kind"`
	} `json:"review"`
}

// lockfileFinding: a turn that ran a command left a lockfile from another
// package manager than the one setup found, in the root or a Node package
// folder, written since the turn began. Built in: it needs no entry. Silent
// when setup found no manager, or the repo already keeps two lockfiles.
func lockfileFinding(ev contract.Event, env Environment, turn stopTurn) (stopFinding, bool) {
	if !turn.commands || turn.since.IsZero() || env.Home == "" {
		return stopFinding{}, false
	}
	facts, ok := readSetupRecipes(filepath.Join(env.Home, "projects", ev.ProjectID, "recipes.json"))
	if !ok || installCommand[facts.Manager] == "" {
		return stopFinding{}, false
	}
	for _, r := range facts.Review {
		if r.Kind == "two-lockfiles" {
			return stopFinding{}, false
		}
	}
	folders := []string{""}
	for _, p := range facts.Packages {
		if p.Kind == "node" && p.Path != "" && len(folders) < stopMaxPackages {
			folders = append(folders, p.Path)
		}
	}
	names := make([]string, 0, len(lockfiles))
	for name := range lockfiles {
		names = append(names, name)
	}
	sort.Strings(names)
	var found []string
	wrong := ""
	for _, folder := range folders {
		for _, name := range names {
			manager := lockfiles[name]
			if manager == facts.Manager {
				continue
			}
			rel := path.Join(folder, name)
			info, err := os.Stat(filepath.Join(ev.Checkout, filepath.FromSlash(rel)))
			if err != nil || !info.Mode().IsRegular() || !info.ModTime().After(turn.since) {
				continue
			}
			found = append(found, rel)
			if wrong == "" {
				wrong = manager
			}
		}
	}
	if len(found) == 0 {
		return stopFinding{}, false
	}
	return stopFinding{rule: stopLockfileRule, files: found, line: fmt.Sprintf(
		"This turn left %s, a lockfile from %s, but this repo uses %s. Delete %s and install with `%s` instead.",
		namedFiles(found), wrong, facts.Manager, pick(len(found), "it", "them"), installCommand[facts.Manager])}, true
}

func readSetupRecipes(file string) (setupRecipes, bool) {
	var r setupRecipes
	info, err := os.Stat(file)
	if err != nil || !info.Mode().IsRegular() || info.Size() > recipesBytes {
		return r, false
	}
	data, err := os.ReadFile(file)
	if err != nil || json.Unmarshal(data, &r) != nil || r.Version != 1 {
		return setupRecipes{}, false
	}
	return r, true
}
