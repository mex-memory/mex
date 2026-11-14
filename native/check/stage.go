package check

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/index"
	localrecord "github.com/mex-memory/mex/native/record"
)

// VerdictStore is the verdict cache: hooks.db's verdicts table.
type VerdictStore interface {
	Verdicts(projectID, checkout string) (map[string]localrecord.Verdict, error)
	PutVerdicts(projectID, checkout string, verdicts []localrecord.Verdict) error
	DropVerdicts(projectID, checkout string, keep []string) error
}

// StageOptions say what the free stage looks at.
type StageOptions struct {
	Checkout        string
	ProjectID       string
	MexHome         string
	RecordDirectory string // where the file index lives; "" for none
	Store           VerdictStore
	// Paths limits the run to entries that read these checkout-relative
	// files ('/' separators), or whose own file is one of them. Nil means
	// every entry.
	Paths []string
	// Deadline stops the run between entries; Unfinished then says so.
	Deadline time.Time
	Now      time.Time
}

// StageReport is what one run did.
type StageReport struct {
	Entries    int            `json:"entries"`
	Evaluated  int            `json:"evaluated"`
	Reused     int            `json:"reused"`
	Invalid    int            `json:"invalid"`
	Counts     map[string]int `json:"counts"`
	Unfinished bool           `json:"unfinished"`
	Results    []Result       `json:"results"`
}

// RunStage is stage one of keeping knowledge true: free, local, no model. It
// re-runs the checks of entries whose inputs changed since their cached
// verdict and stores the new verdicts. Entries whose inputs are the same keep
// theirs, so a formatting-only change is recorded once and then reused.
func RunStage(opts StageOptions) (StageReport, error) {
	report := StageReport{Counts: map[string]int{}}
	loaded, err := LoadAll(opts.Checkout, opts.MexHome, opts.ProjectID)
	if err != nil {
		return report, err
	}
	ev, err := NewEvaluator(opts.Checkout)
	if err != nil {
		return report, err
	}
	defer ev.Close()
	asOf := ""
	if opts.RecordDirectory != "" && opts.ProjectID != "" {
		if ix, err := index.Open(opts.RecordDirectory, opts.ProjectID, opts.Checkout); err == nil {
			defer ix.Close()
			ev.UseIndex(ix)
			asOf = ix.AsOf()
		}
	}
	cached, err := opts.Store.Verdicts(opts.ProjectID, opts.Checkout)
	if err != nil {
		cached = map[string]localrecord.Verdict{}
	}
	wanted := map[string]bool{}
	for _, p := range opts.Paths {
		wanted[p] = true
	}
	now := opts.Now
	if now.IsZero() {
		now = time.Now()
	}
	checkedAt := now.UTC().Format(time.RFC3339)

	var fresh []localrecord.Verdict
	var valid []string
	for _, l := range loaded {
		if l.Err != nil {
			report.Invalid++
			continue
		}
		report.Entries++
		valid = append(valid, l.Entry.ID)
		if opts.Paths != nil && !touches(l, opts.Checkout, wanted) {
			if v, ok := cached[l.Entry.ID]; ok {
				report.Counts[v.Verdict]++
			}
			continue
		}
		if report.Unfinished || (!opts.Deadline.IsZero() && time.Now().After(opts.Deadline)) {
			report.Unfinished = true
			if v, ok := cached[l.Entry.ID]; ok {
				report.Counts[v.Verdict]++
			}
			continue
		}
		inputs := ev.inputsHash(l, asOf)
		if v, ok := cached[l.Entry.ID]; ok && v.InputsHash == inputs {
			report.Reused++
			report.Counts[v.Verdict]++
			continue
		}
		res := ev.Evaluate(l.Entry)
		report.Evaluated++
		report.Counts[res.Verdict]++
		report.Results = append(report.Results, res)
		fresh = append(fresh, localrecord.Verdict{EntryID: l.Entry.ID, Verdict: res.Verdict, InputsHash: inputs, CheckedAt: checkedAt})
	}
	if len(fresh) > 0 {
		if err := opts.Store.PutVerdicts(opts.ProjectID, opts.Checkout, fresh); err != nil {
			return report, err
		}
	}
	if opts.Paths == nil && !report.Unfinished {
		if err := opts.Store.DropVerdicts(opts.ProjectID, opts.Checkout, valid); err != nil {
			return report, err
		}
	}
	return report, nil
}

// targetFiles lists the repository files a check reads.
func targetFiles(c Check) []string {
	files := make([]string, 0, len(c.Files)+1)
	for p := range c.Files {
		files = append(files, p)
	}
	if f := str(c.Target, "file"); f != "" {
		files = append(files, f)
	}
	return files
}

// touches says whether an entry reads one of the changed paths, or is one.
func touches(l Loaded, checkout string, changed map[string]bool) bool {
	if rel, err := filepath.Rel(checkout, l.Path); err == nil && changed[filepath.ToSlash(rel)] {
		return true
	}
	for _, c := range l.Entry.Checks {
		if c.Kind == "pattern" || c.Kind == "symbol" {
			// A pattern's scope or a moved symbol can involve any file.
			for p := range changed {
				if c.Kind == "symbol" || matchScope(str(c.Target, "scope"), p) {
					return true
				}
			}
		}
		for _, f := range targetFiles(c) {
			if changed[f] {
				return true
			}
		}
	}
	return false
}

// matchScope is a cheap prefix test for "does this edit fall in scope".
func matchScope(scope, path string) bool {
	prefix := scope
	if i := strings.IndexAny(prefix, "*?[{"); i >= 0 {
		prefix = prefix[:i]
	}
	return strings.HasPrefix(path, prefix)
}

// inputsHash fingerprints everything an entry's verdict depends on: its own
// file, the current state of every file its checks read, and the file
// index's snapshot when a check reads the index.
func (ev *Evaluator) inputsHash(l Loaded, asOf string) string {
	lines := []string{"entry " + l.Hash}
	for _, c := range l.Entry.Checks {
		for _, f := range targetFiles(c) {
			lines = append(lines, "file "+f+" "+inputState(ev.files.read(f)))
		}
		if c.Kind == "symbol" || c.Kind == "pattern" {
			lines = append(lines, "index "+asOf)
		}
	}
	sort.Strings(lines)
	sum := sha256.Sum256([]byte(strings.Join(lines, "\n")))
	return "sha256:" + hex.EncodeToString(sum[:])
}
