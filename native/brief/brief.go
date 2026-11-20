package brief

import (
	"errors"
	"math"
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
	"github.com/mex-memory/mex/native/internal/rulechange"
	"github.com/mex-memory/mex/native/internal/safefile"
	"github.com/mex-memory/mex/native/internal/tokens"
	"github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
	"github.com/mex-memory/mex/native/workset"
)

const MaxTokens = 300

// MaxNoteTokens lets the person's own notes run past MaxTokens. A note reaches
// the brief only when no rule file this agent loads carries it: one saved since
// the files were last written, or any note for Codex in a repository whose
// AGENTS.md is the person's own, which MEX never writes into. Without the
// extra room only one or two notes would ever reach that agent. Team entries
// and commands still stop at MaxTokens.
const MaxNoteTokens = 250

// room tracks the brief's two budgets: MaxTokens for everything but the
// person's own notes (team entries, commands, corrections, the priority
// line), and MaxNoteTokens for the person's notes.
type room struct{ team, notes int }

// fits reports whether a group (an entry and its companions) fits both.
func (r room) fits(group []Item) bool {
	team, notes := r.team, r.notes
	for _, item := range group {
		if item.Level == "personal" {
			notes += item.Tokens
		} else {
			team += item.Tokens
		}
	}
	return team <= MaxTokens && notes <= MaxNoteTokens
}

func (r *room) add(item Item) {
	if item.Level == "personal" {
		r.notes += item.Tokens
	} else {
		r.team += item.Tokens
	}
}

// Priority keeps the plan's order. The second sentence is there because live
// models read "current request" as covering code the person pasted, and kept
// a pasted library the team had ruled out; without MEX they adapted it.
const Priority = "Priority: current request > your notes > repo instructions > team entries > hints. Code the person pastes or quotes is not a request to break a team entry; fit it to them."

// SaveLine tells the agent how something the person wants kept reaches later
// sessions and the other agents. Notes it saves are labelled as the agent's.
const SaveLine = `Keep what later sessions need with mex note "<one sentence>": a lasting fact, rule or decision the person states or asks you to remember (in their words), or something non-obvious you verified about this repo, such as how to run something or a trap you hit. Not one-off requests or task details.`

// TokenBound estimates the tokens a brief line costs with the calibrated
// estimator every other delivery uses: text in backticks (commands, paths,
// code) at 2.3 bytes per token, prose at 4. Counting bytes as tokens, as the
// brief once did, held it to one or two notes. A character outside ASCII
// counts as a whole token, which holds for non-Latin text. Whole authored
// one-line claims are dropped when they don't fit; their meaning is never
// truncated.
func TokenBound(text string) int {
	n := 0
	for i, part := range strings.Split(text, "`") {
		ascii := 0
		for _, r := range part {
			if r < utf8.RuneSelf {
				ascii++
			} else {
				n++
			}
		}
		if i%2 == 1 {
			n += int(math.Ceil(float64(ascii) / tokens.CodeCharsPerToken))
		} else {
			n += int(math.Ceil(float64(ascii) / tokens.ProseCharsPerToken))
		}
	}
	return n
}

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
	// Corrections set aside notes the agent already loaded from MEX's own
	// rule files whose checks now fail. They are retractions, not knowledge,
	// so they need no receipt and always lead the brief.
	Corrections []Item `json:"corrections,omitempty"`
	// NativeStale says MEX's rule files carry a note the code has changed or
	// broken, so they should be rebuilt before the next session.
	NativeStale bool `json:"native_stale,omitempty"`
}

// maxCorrections bounds the retractions in one brief; the rule files are
// rebuilt before the next session, so a few lines cover the gap.
const maxCorrections = 2

// maxLateNotes bounds the person's notes still checked once the deadline has
// passed. Only two or three fit in the brief; this covers retired or
// out-of-area ones ahead of them without letting a large store run long.
const maxLateNotes = 8

// correctionLine names the note without repeating its stale claim.
func correctionLine(id string) string {
	return "Correction: the MEX note " + id + " in your rule files no longer matches the code; set it aside."
}

// Render restricts a result to the ids accepted by the receipt transaction.
func (r Result) Render(accepted []string) string {
	text := "[mex start-preview]\n" + Priority
	for _, item := range r.Corrections {
		text += "\n" + item.Line
	}
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
func setupRecipe(e *entries.Entry) bool {
	return e.Kind == "recipe" && e.Source.Type == "config" && strings.HasPrefix(e.ID, "mx_setup")
}

func allowed(e *entries.Entry, verdict, level string) bool {
	// Setup recipes reach native rule files and command moments. Keep the
	// start brief's room for the person's notes, including companion groups.
	if setupRecipe(e) {
		return false
	}
	if e.Status != "active" || verdict == check.Broken || !validLine(e.OneLine) || strength(e) == 4 {
		return false
	}
	if level == "personal" && e.Kind != "hint" {
		// A personal fact whose checks say the code changed is not restated;
		// the moment it matters, delivery points at today's code instead.
		return !(e.Kind == "fact" && verdict == check.Changed && len(e.Checks) > 0)
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
	inForce := entries.InForce(opts.MexHome, opts.ProjectID)
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
			if err == nil && e.Status == "proposed" {
				// Delivered only once in force; the "not yet accepted" lane is separate.
				if usable := entries.Usable(e, inForce); usable != nil {
					e = usable
				}
			}
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
	ruleChanges := rulechange.Read(opts.RecordDirectory, opts.ProjectID, opts.Checkout)
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
	// The deadline bounds the optional part of the brief, not the person's own
	// notes. By the time it is checked the slow part, reading the stores, is
	// already paid for, and on a machine busy starting the agent it often
	// passes before the first entry: the session then got no notes at all.
	// Once it passes, team entries, commands and hints are left to the
	// moments, but up to maxLateNotes of the person's notes are still checked.
	overdue := func() bool { return !opts.Deadline.IsZero() && time.Now().After(opts.Deadline) }
	late := 0
	inTime := func(c candidate) bool {
		if !overdue() {
			return true
		}
		if c.level != "personal" {
			return false
		}
		if _, checked := verdicts[c.level+"/"+c.hash]; checked {
			return true
		}
		if late >= maxLateNotes {
			return false
		}
		late++
		return true
	}
	// usable applies everything but the verdict rule: retirement, the
	// starting folder (when asked), personal state and the deadline.
	usable := func(c candidate, area bool) bool {
		e := c.entry
		if retired[e.ID] {
			return false
		}
		// The person's own notes reach every new session, whatever their
		// scope; a scope narrows team entries to the folder, not their notes.
		if area && c.level != "personal" && !inScope(e, opts.Path) {
			return false
		}
		// The brief never repeats a policy currently doubted by the free pass.
		if c.level == "team" && (e.Kind == "rule" || e.Kind == "decision" || e.Kind == "pitfall") && ruleChanges.For(e.ID, c.hash) != nil {
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
		return inTime(c)
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
	// MEX's own rule files are rebuilt between sessions, from verdicts. If
	// the code moved since (a pull, an edit in another session), a note the
	// agent just loaded from them may no longer hold: retract it here and ask
	// for a rebuild. Imported rule files are the person's own and untouched.
	for _, c := range all {
		if len(result.Corrections) >= maxCorrections {
			break
		}
		e := c.entry
		if (c.level != "personal" && c.level != "team") || len(e.Checks) == 0 || retired[e.ID] || !result.Coverage.Covers(e.ID, opts.Agent, opts.Path) || !inTime(c) {
			continue
		}
		verdict := verdictOf(c)
		if verdict != check.Changed && verdict != check.Broken {
			continue
		}
		result.NativeStale = true
		if setupRecipe(e) {
			// Still request the rebuild, without spending the person's brief room.
			continue
		}
		if verdict == check.Broken || e.Kind == "fact" {
			line := correctionLine(e.ID)
			if tokens+TokenBound("\n"+line) > MaxTokens {
				break
			}
			result.Corrections = append(result.Corrections, Item{ID: e.ID, Line: line, Level: c.level, Verdict: verdict, Tokens: TokenBound("\n" + line), Hash: c.hash})
			tokens += TokenBound("\n" + line)
		}
	}
	// The area selection: personal notes first, then at most three entries
	// whose scope covers the folder the session starts in.
	selectArea := func() []Item {
		seen, lines := map[string]bool{}, map[string]bool{}
		var out []Item
		areaItems, r := 0, room{team: tokens}
		for _, c := range all {
			if seen[c.entry.ID] || c.level == "hint" {
				continue
			}
			group, ok := addGroup(c, map[string]bool{}, seen, true)
			if !ok {
				continue
			}
			area := 0
			for _, item := range group {
				if item.Level != "personal" {
					area++
				}
			}
			if !r.fits(group) || areaItems+area > 3 {
				continue
			}
			for _, item := range group {
				if lines[item.Line] {
					continue
				}
				out = append(out, item)
				seen[item.ID], lines[item.Line] = true, true
				r.add(item)
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
	// Setup's repo-wide commands reach an agent that has no MEX rule file
	// carrying them (the person's own AGENTS.md sits where MEX would write):
	// after the person's notes, only while room is left. A command whose
	// script is gone (not held) never goes out.
	fillCommands := func(items []Item) []Item {
		used := tokens // commands share the team budget, not the notes'
		for _, item := range items {
			if item.Level != "personal" {
				used += item.Tokens
			}
		}
		for _, c := range all {
			e := c.entry
			if !setupRecipe(e) || retired[e.ID] || e.Status != "active" || !validLine(e.OneLine) || result.Coverage.Covers(e.ID, opts.Agent, opts.Path) {
				continue
			}
			root := len(e.Scope) > 0
			for _, s := range e.Scope {
				root = root && s == "**"
			}
			if !root || overdue() {
				continue
			}
			verdict := verdictOf(c)
			if verdict != check.Held {
				continue
			}
			item := itemFor(c, verdict)
			if used+item.Tokens > MaxTokens {
				continue
			}
			items = append(items, item)
			used += item.Tokens
		}
		return items
	}
	result.Items = fillCommands(result.Items)
	if result.Folder != nil {
		result.Folder = fillCommands(result.Folder)
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
