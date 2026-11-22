package check

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/graph"
	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/internal/judgement"
	"github.com/mex-memory/mex/native/internal/rulechange"
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
	// Force evaluates every entry, even when its inputs are unchanged.
	Force bool
	// TeamOnly skips personal notes and hints (CI has no MEX home).
	TeamOnly bool
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
	// Results holds what this run evaluated.
	Results []Result `json:"results"`
	// Items lists every valid entry with its current verdict.
	Items []StageItem `json:"items"`
	// Problems lists entry files that aren't valid entries.
	Problems []StageProblem `json:"problems"`
	// Flipped lists entries whose stored verdict went from held to not held,
	// or back, in this run: rule files that carry them must be rebuilt.
	Flipped []string `json:"flipped,omitempty"`
}

// StageItem is one entry as the run left it.
type StageItem struct {
	ID      string `json:"id"`
	Level   string `json:"level"`
	Path    string `json:"path"`
	Kind    string `json:"kind"`
	Status  string `json:"status"`
	Verdict string `json:"verdict"`
	// EntryHash binds a consumer to the exact entry this evaluator parsed.
	EntryHash           string   `json:"entry_hash"`
	RuleEvidence        []string `json:"rule_evidence,omitempty"`
	RuleEvidencePending bool     `json:"rule_evidence_pending,omitempty"`
	Label               string   `json:"label,omitempty"`
	Learned             bool     `json:"learned,omitempty"`
}

// StageProblem is an entry file that couldn't be read as an entry.
type StageProblem struct {
	Level string `json:"level"`
	Path  string `json:"path"`
	Error string `json:"error"`
}

// RunStage is stage one of keeping knowledge true: free, local, no model. It
// re-runs the checks of entries whose inputs changed since their cached
// verdict and stores the new verdicts. Entries whose inputs are the same keep
// theirs, so a formatting-only change is recorded once and then reused.
func RunStage(opts StageOptions) (StageReport, error) {
	report := StageReport{Counts: map[string]int{}}
	home, project := opts.MexHome, opts.ProjectID
	if opts.TeamOnly {
		home, project = "", ""
	}
	var cache *entryCache
	if opts.RecordDirectory != "" && opts.Store != nil {
		cache = openEntryCache(EntryCachePath(opts.RecordDirectory, opts.Checkout))
	}
	loaded, err := loadAll(opts.Checkout, home, project, cache)
	if err != nil {
		return report, err
	}
	defer cache.save(time.Now())
	ev, err := NewEvaluator(opts.Checkout)
	if err != nil {
		return report, err
	}
	defer ev.Close()
	defer ev.useURLRecords(opts.RecordDirectory, opts.ProjectID)()
	asOf := ""
	if opts.RecordDirectory != "" && opts.ProjectID != "" {
		if ix, err := index.Open(opts.RecordDirectory, opts.ProjectID, opts.Checkout); err == nil {
			defer ix.Close()
			ev.UseIndex(ix)
			asOf = ix.AsOf()
		}
		// Calls relations read the code graph when the checkout has one.
		if g, err := graph.OpenStore(opts.RecordDirectory, opts.ProjectID, opts.Checkout, nil); err == nil {
			defer g.Close()
			ev.UseGraph(g)
		}
	}
	cached := map[string]localrecord.Verdict{}
	if opts.Store != nil {
		if found, err := opts.Store.Verdicts(opts.ProjectID, opts.Checkout); err == nil {
			cached = found
		}
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
	ruleChanges := rulechange.Read(opts.RecordDirectory, opts.ProjectID, opts.Checkout)
	var judged *judgement.Reader
	judgedTried := opts.TeamOnly
	defer func() { judged.Close() }()

	var fresh []localrecord.Verdict
	var valid []string
	for _, l := range loaded {
		if l.Err != nil {
			report.Invalid++
			report.Problems = append(report.Problems, StageProblem{Level: l.Level, Path: l.Path, Error: l.Err.Error()})
			continue
		}
		report.Entries++
		valid = append(valid, l.Entry.ID)
		item := StageItem{ID: l.Entry.ID, Level: l.Level, Path: l.Path, Kind: l.Entry.Kind, Status: l.Entry.Status, EntryHash: l.Hash,
			Learned: l.Entry.Source.Learned(l.Entry.ID)}
		keep := func() {
			if v, ok := cached[l.Entry.ID]; ok {
				item.Verdict = v.Verdict
				report.Counts[v.Verdict]++
			}
			report.Items = append(report.Items, item)
		}
		if opts.Paths != nil && !touches(l, opts.Checkout, wanted) && !judgement.ModelKey(cached[l.Entry.ID].InputsHash) {
			keep()
			continue
		}
		if report.Unfinished || (!opts.Deadline.IsZero() && time.Now().After(opts.Deadline)) {
			report.Unfinished = true
			// An unverified model hold must not survive a partial/deadline run.
			if v, ok := cached[l.Entry.ID]; ok && judgement.ModelKey(v.InputsHash) {
				v.Verdict = Unknown
				v.InputsHash = "unverified"
				v.CheckedAt = checkedAt
				cached[l.Entry.ID] = v
				fresh = append(fresh, v)
			}
			keep()
			continue
		}
		inputs := ev.inputsHash(l, asOf)
		var signal *rulechange.Signal
		learned := item.Learned
		if policySignal(l.Entry.Kind, l.Level, learned) {
			signal = ruleChanges.For(l.Entry.ID, l.Hash)
			if signal != nil {
				item.RuleEvidence = signal.Reasons
				item.RuleEvidencePending = signal.Pending
			}
		}
		inputs = withRuleSignal(inputs, signal)
		evaluationHash := inputs
		modelHeld := false
		eligible := (l.Entry.Kind == "fact" || learned) && l.Entry.Status == "active"
		for _, c := range l.Entry.Checks {
			if c.Kind == "legacy-grounding" {
				eligible = false
			}
		}
		if eligible {
			if !judgedTried {
				judgedTried = true
				judged = judgement.Open(opts.RecordDirectory, opts.ProjectID, opts.Checkout)
			}
			inputs, modelHeld = judged.CacheKey(l.Entry.ID, l.Hash, evaluationHash)
		}
		if v, ok := cached[l.Entry.ID]; ok && v.InputsHash == inputs && !opts.Force {
			if modelHeld && v.Verdict == Held {
				item.Label = "checked by model"
			}
			report.Reused++
			keep()
			continue
		}
		res := ev.Evaluate(l.Entry)
		res.EvaluationHash = evaluationHash
		if signal != nil {
			if res.Verdict != Broken {
				res.Verdict = Changed
			}
			if !signal.Pending {
				for _, input := range signal.Files {
					res.Inputs[input.Path] = input.Hash
				}
			}
		}
		readable := true
		for _, c := range res.Checks {
			if (c.Status == Floor || c.Status == Gone) && !(learned && c.Role == Supporting) {
				readable = false
			}
		}
		if modelHeld && readable && res.Verdict == Changed && !item.RuleEvidencePending {
			res.Verdict = Held
			item.Label = "checked by model"
			res.Label = item.Label
		}
		report.Evaluated++
		report.Counts[res.Verdict]++
		report.Results = append(report.Results, res)
		item.Verdict = res.Verdict
		report.Items = append(report.Items, item)
		fresh = append(fresh, localrecord.Verdict{EntryID: l.Entry.ID, Verdict: res.Verdict, InputsHash: inputs, CheckedAt: checkedAt})
		if v, ok := cached[l.Entry.ID]; ok && (v.Verdict == Held) != (res.Verdict == Held) {
			report.Flipped = append(report.Flipped, l.Entry.ID)
		}
	}
	if opts.Store == nil {
		return report, nil
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

func policySignal(kind, level string, learned bool) bool {
	policy := kind == "rule" || kind == "decision" || kind == "pitfall"
	return level == Team && policy || learned && level != Hint && (policy || kind == "procedure")
}

func withRuleSignal(inputs string, signal *rulechange.Signal) string {
	if signal == nil {
		return inputs
	}
	raw, _ := json.Marshal(signal)
	if signal.Pending {
		raw = append(raw, []byte(" pending")...)
	}
	return hashBytes(append([]byte(inputs), raw...))
}

// targetFiles lists the repository files a check reads.
func targetFiles(c Check) []string {
	if c.Kind == "fixture" {
		return nil
	}
	files := make([]string, 0, len(c.Files)+1)
	for p := range c.Files {
		files = append(files, p)
	}
	if f := str(c.Target, "file"); f != "" {
		files = append(files, f)
	}
	if c.Kind == "pattern" {
		if file := exactPatternFile(c.Target); file != "" {
			for _, known := range files {
				if known == file {
					return files
				}
			}
			files = append(files, file)
		}
	}
	return files
}

// touches says whether an entry reads one of the changed paths, or is one.
func touches(l Loaded, checkout string, changed map[string]bool) bool {
	if rel, err := filepath.Rel(checkout, l.Path); err == nil && changed[filepath.ToSlash(rel)] {
		return true
	}
	for _, c := range l.Entry.Checks {
		if c.Kind == "pattern" || c.Kind == "symbol" || c.Kind == "scope" {
			// A pattern's scope or a moved symbol can involve any file.
			scope := str(c.Target, "scope")
			if c.Kind == "scope" {
				scope = str(c.Target, "glob")
			}
			for p := range changed {
				if c.Kind == "symbol" || matchScope(scope, p) {
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
		if c.Kind == "symbol" || c.Kind == "pattern" || c.Kind == "relation" || c.Kind == "scope" {
			lines = append(lines, "index "+asOf)
		}
		if c.Kind == "relation" && str(c.Target, "query") == "calls" && ev.graph != nil {
			lines = append(lines, "graph "+ev.graph.AsOf())
		}
		// A folder count read while the index is behind HEAD is re-read once it catches up.
		if c.Kind == "pattern" && exactPatternFile(c.Target) == "" && ev.indexBehindHead() {
			lines = append(lines, "index behind HEAD")
		}
		if c.Kind == "scope" && ev.indexBehindHead() {
			lines = append(lines, "index behind HEAD")
		}
		if url := str(c.Target, "url"); c.Kind == "source" && url != "" && ev.urlSource != nil {
			raw, _ := ev.urlSource(url)
			lines = append(lines, "url "+url+" "+hashBytes([]byte(raw)))
		}
	}
	sort.Strings(lines)
	sum := sha256.Sum256([]byte(strings.Join(lines, "\n")))
	return "sha256:" + hex.EncodeToString(sum[:])
}
