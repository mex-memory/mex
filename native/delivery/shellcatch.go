package delivery

// Edits made by shell scripts can't be stopped before they run: the hook sees
// only the command. They are caught afterwards (plan sheet 31): after a shell
// command, a file in a strong rule's scope that changed outside any recorded
// edit and now holds the rule's literal anti-pattern, which the file index
// counted zero of at its last parse, brings the rule as an edit moment.

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/check"
	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/internal/contract"
)

const (
	// shellCatchWindow: only files changed this recently can be the
	// command's work.
	shellCatchWindow = 2 * time.Minute
	// shellCatchBudget bounds the file checks one command may cost.
	shellCatchBudget = 8 * time.Millisecond
	shellCatchPaths  = 2000
	shellCatchBytes  = 1 << 20
)

// shellCaught returns edit-moment candidates for rules a shell command broke.
func shellCaught(v toolView, env Environment, snap *entries.Snapshot) []candidate {
	if v.name != contract.ToolShell || v.checkout == "" || v.project == "" || v.failed || v.command == "" || readsOrSearches(v.command) || snap == nil {
		return nil
	}
	type rule struct {
		it       *entries.Item
		patterns []string
	}
	var rules []rule
	for i := range snap.Items {
		it := &snap.Items[i]
		if !strongRule(it) {
			continue
		}
		var ps []string
		for _, t := range it.Entry.When {
			if t.Type == "anti" && t.Match == "literal" && precise(t) {
				ps = append(ps, t.Pattern)
			}
		}
		if len(ps) > 0 {
			rules = append(rules, rule{it, ps})
		}
	}
	if len(rules) == 0 {
		return nil
	}
	idx, err := index.Open(env.RecordDirectory, v.project, v.checkout)
	if err != nil {
		return nil // no index: stay silent
	}
	defer idx.Close()
	now := env.Now
	if now.IsZero() {
		now = time.Now()
	}
	deadline := time.Now().Add(shellCatchBudget)
	since := now.Add(-shellCatchWindow)
	changed := map[string]string{} // rel → current text, for files the command may have changed
	checked := map[string]bool{}
	var out []candidate
	for _, r := range rules {
	scopes:
		for _, glob := range r.it.Entry.Scope {
			paths, _, err := idx.PathsMatching(glob, shellCatchPaths)
			if err != nil {
				continue
			}
			for _, rel := range paths {
				if time.Now().After(deadline) {
					return out
				}
				if !checked[rel] {
					checked[rel] = true
					if text, ok := changedByCommand(idx, v.checkout, rel, since); ok {
						changed[rel] = text
					}
				}
				text, ok := changed[rel]
				if !ok || !inScope(r.it, rel) {
					continue
				}
				for _, p := range r.patterns {
					if !strings.Contains(text, p) {
						continue
					}
					id := check.PatternID(p)
					counts, err := idx.PatternCounts(rel, []string{id})
					if before, known := counts[id]; err != nil || !known || before > 0 {
						continue // the index never counted it, or it was already there
					}
					out = append(out, candidate{item: r.it, moment: momentEdit, tier: tierPattern, exempt: true, rel: rel})
					break scopes
				}
			}
		}
	}
	return out
}

// changedByCommand reports a file modified recently that the index says
// changed outside any edit the hook recorded, with its current text.
func changedByCommand(idx *index.Reader, checkout, rel string, since time.Time) (string, bool) {
	full := filepath.Join(filepath.FromSlash(checkout), filepath.FromSlash(rel))
	info, err := os.Stat(full)
	if err != nil || !info.Mode().IsRegular() || info.ModTime().Before(since) || info.Size() > shellCatchBytes {
		return "", false
	}
	if _, miss := idx.FileInfo(rel); miss == nil || miss.NotIndexed != "changed since the last parse" {
		return "", false
	}
	f, err := os.Open(full)
	if err != nil {
		return "", false
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, shellCatchBytes))
	if err != nil {
		return "", false
	}
	return string(data), true
}
