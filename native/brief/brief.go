package brief

import (
	"errors"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/mex-memory/mex/native/check"
	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/internal/safefile"
	"github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
	"github.com/mex-memory/mex/native/workset"
)

const MaxTokens = 300

const Priority = "Priority: current request > your notes > repo instructions > team entries > hints."

// TokenBound uses UTF-8 bytes as a conservative token upper bound. Unlike a
// characters/4 estimate this also holds for punctuation and non-Latin text.
// We drop whole authored one-line claims, never truncate their meaning.
func TokenBound(text string) int { return len([]byte(text)) }

type Options struct {
	Checkout        string `json:"checkout"`
	MexHome         string `json:"mex_home"`
	ProjectID       string `json:"project_id"`
	Agent           string `json:"agent"`
	RecordDirectory string `json:"record_directory,omitempty"`
	SessionID       string `json:"session_id,omitempty"`
	AgentID         string `json:"agent_id,omitempty"`
	// NativeCwd is the host's actual working directory. Codex loads its
	// ancestor instruction chain at startup, not arbitrary nested files on read.
	NativeCwd string `json:"native_cwd,omitempty"`
	// Path is relative to Checkout, not the shell's folder in another repo.
	Path     string    `json:"path"`
	Deadline time.Time `json:"-"`
	// WorkingSet, when it names anything, chooses the brief by the files in
	// progress instead of by the starting folder.
	WorkingSet *workset.Set `json:"-"`
	// HintAllowed admits an observed hint to the not-yet-accepted lane.
	HintAllowed func(id string) bool `json:"-"`
}

type Item struct {
	ID      string   `json:"id"`
	Line    string   `json:"line"`
	Level   string   `json:"level"`
	Verdict string   `json:"verdict"`
	Tokens  int      `json:"tokens"`
	Hash    string   `json:"-"`
	Scopes  []string `json:"-"`
}

type Result struct {
	Text     string   `json:"text"`
	Tokens   int      `json:"token_bound"`
	Items    []Item   `json:"items"`
	Coverage Coverage `json:"coverage"`
	// Lane holds knowledge nobody has accepted yet, rendered apart.
	Lane []Item `json:"lane,omitempty"`
	// Folder is the starting-folder selection, computed beside the
	// working-set one so a session can be given either.
	Folder []Item `json:"-"`
}

// Render restricts a result to the ids accepted by the receipt transaction.
func (r Result) Render(accepted []string) string {
	text := "[mex start-preview]\n" + Priority
	for _, item := range r.Items {
		if contains(accepted, item.ID) {
			text += "\n" + item.Line + " (" + item.ID + ")"
		}
	}
	heading := false
	for _, item := range r.Lane {
		if contains(accepted, item.ID) {
			if !heading {
				text += "\n" + LaneHeading
				heading = true
			}
			text += "\n" + item.Line + " (" + item.ID + ")"
		}
	}
	return text
}

type candidate struct {
	entry *entries.Entry
	level string
	hash  string
}

func validLine(line string) bool {
	if strings.TrimSpace(line) == "" || len(line) > 1024 || !utf8.ValidString(line) {
		return false
	}
	for _, c := range line {
		if unicode.IsControl(c) || unicode.Is(unicode.Cf, c) {
			return false
		}
	}
	return !strings.Contains(line, "[mex ")
}

func strength(e *entries.Entry) int {
	switch e.Evidence {
	case "person":
		return 0
	case "ci":
		return 1
	case "docs":
		return 2
	case "review":
		return 3
	}
	return 4
}

func inScope(e *entries.Entry, file string) bool {
	if len(e.Scope) == 0 || len(e.Scope) > 32 {
		return false
	}
	for _, scope := range e.Scope {
		if safePath(scope) && index.MatchesScope(scope, file) {
			return true
		}
	}
	return false
}

// allowed deliberately leaves changed code facts and recipes out. Their pointer
// and re-derivation forms belong to the moment controller, not a start digest.
func allowed(e *entries.Entry, verdict, level string) bool {
	if e.Status != "active" || verdict == check.Broken || !validLine(e.OneLine) || strength(e) == 4 {
		return false
	}
	if level == "personal" && e.Kind != "hint" {
		return true
	}
	switch e.Kind {
	case "rule", "decision", "pitfall", "procedure":
		return true
	case "recipe":
		return verdict == check.Held
	}
	return false
}

// Build is a read-only projection. No verdict cache can authorize stale text:
// every eligible candidate is evaluated against the current checkout here.
func Build(opts Options) (Result, error) {
	result := Result{Items: []Item{}}
	canonical, err := place.RealPath(opts.Checkout)
	if err != nil {
		return result, err
	}
	opts.Checkout = canonical
	if opts.Agent != "claude-code" && opts.Agent != "codex" {
		return result, errors.New("unsupported brief agent")
	}
	if opts.Path != "" && !safePath(opts.Path) {
		return result, errors.New("path must be checkout-relative")
	}
	if !strings.HasPrefix(opts.ProjectID, "g-") && !strings.HasPrefix(opts.ProjectID, "f-") {
		return result, errors.New("invalid project")
	}
	if !safePath(opts.ProjectID) {
		return result, errors.New("invalid project")
	}
	root, err := os.OpenRoot(opts.Checkout)
	if err != nil {
		return result, err
	}
	defer root.Close()
	home, _ := os.OpenRoot(opts.MexHome)
	if home != nil {
		defer home.Close()
	}
	cache := readRules(root, home, opts)
	result.Coverage = readCoverage(root, home, opts, cache)
	all := []candidate{}
	retired, sourceIDs := map[string]bool{}, map[string]bool{}
	duplicate := false
	remaining, count := scanBudget{maxScanBytes, check.MaxEntries + 32}, 0
	add := func(level string) func(string, []byte) {
		return func(name string, data []byte) {
			count++
			if count > check.MaxEntries {
				return
			}
			e, err := entries.Parse(data)
			if err == nil && path.Base(name) == e.ID+".md" {
				key := level + "/" + e.ID
				duplicate = duplicate || sourceIDs[key]
				sourceIDs[key] = true
				if e.Status == "retired" {
					retired[e.ID] = true
				}
				all = append(all, candidate{e, level, hash(data)})
			}
		}
	}
	if err := walkStore(root, ".mex/learned", 1, &remaining, add("team")); err != nil {
		return result, err
	}
	if err := walkStore(home, "projects/"+opts.ProjectID+"/notes", 0, &remaining, add("personal")); err != nil {
		return result, err
	}
	// Observed hints can only reach the not-yet-accepted lane, which needs a
	// working set to rank them.
	if opts.WorkingSet != nil && opts.HintAllowed != nil {
		if err := walkStore(home, "projects/"+opts.ProjectID+"/hints", 0, &remaining, add("hint")); err != nil {
			return result, err
		}
	}
	if duplicate {
		return result, errors.New("duplicate brief entry id")
	}
	for _, rule := range imported(cache) {
		all = append(all, candidate{rule.Entry, "rule-file", rule.Hash})
	}
	if count+len(cache.Entries) > check.MaxEntries {
		return result, errors.New("too many brief candidates")
	}
	sort.Slice(all, func(i, j int) bool {
		a, b := all[i], all[j]
		if (a.level == "personal") != (b.level == "personal") {
			return a.level == "personal"
		}
		if strength(a.entry) != strength(b.entry) {
			return strength(a.entry) < strength(b.entry)
		}
		return a.entry.ID < b.entry.ID
	})
	evaluator, err := check.NewEvaluator(opts.Checkout)
	if err != nil {
		return result, err
	}
	defer evaluator.Close()
	var personalState *record.Reader
	personalStateOK := true
	directory := opts.RecordDirectory
	if directory == "" {
		directory = opts.MexHome
	}
	recordPath := filepath.Join(directory, "record.db")
	if _, err := os.Stat(recordPath); !os.IsNotExist(err) {
		if !safefile.Regular(recordPath) {
			personalStateOK = false
		} else {
			personalState, err = record.OpenRecord(record.Location{Record: recordPath})
			personalStateOK = err == nil
			if personalState != nil {
				defer personalState.Close()
			}
		}
	}
	byID := map[string]candidate{}
	for _, c := range all {
		if _, exists := byID[c.entry.ID]; !exists {
			byID[c.entry.ID] = c
		}
	}
	// One verdict per entry version, shared by every selection below.
	verdicts := map[string]string{}
	verdictOf := func(c candidate) string {
		key := c.level + "/" + c.hash
		v, ok := verdicts[key]
		if !ok {
			v = evaluator.Evaluate(checkEntry(c.entry)).Verdict
			verdicts[key] = v
		}
		return v
	}
	// usable applies everything but the verdict rule: retirement, the deadline,
	// the starting folder (when asked) and personal state.
	usable := func(c candidate, area bool) bool {
		e := c.entry
		if retired[e.ID] || (!opts.Deadline.IsZero() && time.Now().After(opts.Deadline)) {
			return false
		}
		if area && !inScope(e, opts.Path) {
			return false
		}
		if c.level == "personal" || c.level == "hint" {
			if !personalStateOK {
				return false
			}
			if personalState != nil {
				retired, err := personalState.HasSetting(opts.ProjectID, "knowledge.retired."+e.ID)
				if err != nil || retired {
					return false
				}
			}
		}
		return true
	}
	itemFor := func(c candidate, verdict string) Item {
		e := c.entry
		label := entries.Label(e, c.level)
		if c.level == "rule-file" {
			label = "[repo]"
		}
		line := label + " " + e.OneLine
		return Item{ID: e.ID, Line: line, Level: c.level, Verdict: verdict, Tokens: TokenBound("\n" + line + " (" + e.ID + ")"), Hash: c.hash, Scopes: append([]string{}, e.Scope...)}
	}
	var addGroup groupFunc
	addGroup = func(c candidate, visiting, seen map[string]bool, area bool) ([]Item, bool) {
		e := c.entry
		if len(visiting) >= 32 {
			return nil, false
		}
		if seen[e.ID] || visiting[e.ID] || result.Coverage.Covers(e.ID, opts.Agent, opts.Path) {
			return nil, true
		}
		if !usable(c, area) {
			return nil, false
		}
		verdict := verdictOf(c)
		if !allowed(e, verdict, c.level) {
			return nil, false
		}
		visiting[e.ID] = true
		items := []Item{itemFor(c, verdict)}
		if len(e.Companions) > 32 {
			return nil, false
		}
		for _, id := range e.Companions {
			companion, exists := byID[id]
			if !exists {
				return nil, false
			}
			extra, ok := addGroup(companion, visiting, seen, area)
			if !ok {
				return nil, false
			}
			items = append(items, extra...)
		}
		return items, true
	}
	tokens := TokenBound(Priority) + 32
	// The area selection: personal notes first, then at most three entries
	// whose scope covers the folder the session starts in.
	selectArea := func() []Item {
		seen, lines := map[string]bool{}, map[string]bool{}
		var out []Item
		areaItems, used := 0, tokens
		for _, c := range all {
			if seen[c.entry.ID] || c.level == "hint" {
				continue
			}
			group, ok := addGroup(c, map[string]bool{}, seen, true)
			if !ok {
				continue
			}
			cost, area := 0, 0
			for _, item := range group {
				cost += item.Tokens
				if item.Level != "personal" {
					area++
				}
			}
			if used+cost > MaxTokens || areaItems+area > 3 {
				continue
			}
			for _, item := range group {
				if lines[item.Line] {
					continue
				}
				out = append(out, item)
				seen[item.ID], lines[item.Line] = true, true
				used += item.Tokens
				if item.Level != "personal" {
					areaItems++
				}
			}
		}
		return out
	}
	var sc *scorer
	if opts.WorkingSet != nil {
		sc = newScorer(opts.WorkingSet)
	}
	if sc == nil || sc.empty() {
		result.Items = append(result.Items, selectArea()...)
	} else {
		w := workingSelection{sc: sc, all: all, usable: usable, verdictOf: verdictOf, addGroup: addGroup, itemFor: itemFor, hintAllowed: opts.HintAllowed}
		result.Items = w.main(tokens)
		result.Lane = w.lane()
		result.Folder = selectArea()
	}
	ids := []string{}
	for _, item := range result.Items {
		ids = append(ids, item.ID)
	}
	for _, item := range result.Lane {
		ids = append(ids, item.ID)
	}
	result.Text = result.Render(ids)
	result.Tokens = TokenBound(result.Text)
	return result, nil
}

// The full delivery codec authorizes metadata; the evaluator only needs checks.
func checkEntry(e *entries.Entry) *check.Entry {
	out := &check.Entry{ID: e.ID, Kind: e.Kind, Scope: e.Scope, Status: e.Status}
	for _, c := range e.Checks {
		out.Checks = append(out.Checks, check.Check{Kind: c.Kind, Role: c.Role, Target: c.Target, Saw: c.Saw, Files: c.Files})
	}
	return out
}
