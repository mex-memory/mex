package delivery

// Proof checks at Stop (plan sheet 42, layer E; surface-01). When the agent
// is about to end a turn in which it edited files, MEX checks only what it
// saw itself in that turn: the capture journal's edits and commands, the
// session's changed lines and the light entry snapshot. It never runs a
// repo command. A failing check sends the agent back once, with one reason
// naming every check that failed and what to do next.
//
// Never twice: the checks share the speed bump's once-per-rule state for the
// epoch, a stop the host marks as already continuing (stop_active) is never
// sent back, and nothing is sent back when that state can't be saved. Any
// error gives the empty reply.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/graph"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/internal/shellparse"
	"github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
)

const (
	// stopJournalRows bounds the journal rows one stop reads. A longer turn
	// is checked on its first rows only.
	stopJournalRows = 2048
	// stopMaxObligations bounds the CI obligations one reason names.
	stopMaxObligations = 4
	// stopMaxNamed bounds the files or tests one line names.
	stopMaxNamed = 4
	// stopTestsRule is the budget id of the direct-tests check: one rule.
	stopTestsRule = "mex:direct-tests"
)

// stopFinding is one failed check: the rule it spends from the shared
// budget, and its line in the reason.
type stopFinding struct {
	rule string
	line string
	// files are the checkout-relative files the finding is about.
	files []string
}

// stopTurn is what the journal says happened since the last stop.
type stopTurn struct {
	rows []record.JournalEntry
	// lastEdit is each edited file's last edit row id, and lastEditAt the
	// time that row was written, after the edit.
	lastEdit   map[string]int64
	lastEditAt map[string]time.Time
	// commands is true when the turn ran a shell command.
	commands bool
	// since is when the turn began: the previous stop, else the session's
	// start. Zero when neither is known.
	since time.Time
}

// StopChecks decides one stop event. The caller passes only events from
// agents whose profile can send the agent back at Stop.
func StopChecks(ev contract.Event, env Environment) contract.Reply {
	if ev.Kind != contract.Stop || ev.SessionID == "" || ev.AgentID != "" || ev.ProjectID == "" || ev.Checkout == "" || env.RecordDirectory == "" {
		return contract.Reply{}
	}
	// No record yet means no journal: a stop never creates one.
	hooksDB := filepath.Join(env.RecordDirectory, "hooks.db")
	if _, err := os.Stat(hooksDB); err != nil {
		return contract.Reply{}
	}
	h, err := record.OpenHooks(record.Location{Directory: env.RecordDirectory, Hooks: hooksDB})
	if err != nil {
		return contract.Reply{}
	}
	defer h.Close()

	// The turn: the journal rows since the last stop this session handled.
	// The cursor moves on every stop, sent back or not, so each turn is read
	// once.
	cursorFile := stopCursorPath(env.RecordDirectory, ev)
	cursor := loadStopCursor(cursorFile)
	rows, err := h.JournalAfter(ev.SessionID, cursor.Last, stopJournalRows)
	if err != nil || len(rows) == 0 {
		return contract.Reply{}
	}
	now := env.Now
	if now.IsZero() {
		now = time.Now()
	}
	if saveStopCursor(cursorFile, stopCursor{Last: rows[len(rows)-1].ID, At: now.UTC().Format(time.RFC3339Nano)}) != nil {
		return contract.Reply{} // without a cursor the next stop could read this turn again
	}
	turn := readTurn(rows)
	if (len(turn.lastEdit) == 0 && !turn.commands) || ev.StopActive {
		return contract.Reply{} // a turn that changed nothing, or a stop already sent back
	}
	turn.since = turnStart(h, ev, cursor)

	epoch, _, err := h.CurrentEpoch(ev.SessionID, ev.AgentID)
	if err != nil {
		return contract.Reply{}
	}
	budgetFile := bumpStatePath(env.RecordDirectory, ev)
	state := loadBumpState(budgetFile, epoch.Number)

	var found []stopFinding
	if len(turn.lastEdit) > 0 {
		if snap, err := entries.LoadLight(env.RecordDirectory, env.Home, ev.ProjectID, ev.Checkout); err == nil {
			found = append(found, generatedFindings(ev, env, h, &snap, turn, state)...)
			found = append(found, obligationFindings(ev, h, &snap, turn, state)...)
		}
		if !state.Stopped[stopTestsRule] {
			if f, ok := directTestsFinding(ev, env, turn, found); ok {
				found = append(found, f)
			}
		}
	}
	if !state.Stopped[stopLockfileRule] {
		if f, ok := lockfileFinding(ev, env, turn); ok {
			found = append(found, f)
		}
	}
	if len(found) == 0 {
		return contract.Reply{}
	}
	for _, f := range found {
		state.Stopped[f.rule] = true
	}
	if state.save(budgetFile) != nil {
		return contract.Reply{} // without a record it could send back twice
	}
	for _, f := range found {
		if strings.HasPrefix(f.rule, "mx_") {
			noteViolation(env.RecordDirectory, ev.ProjectID, f.rule, env.Now)
		}
	}
	return contract.Reply{Decision: contract.Deny, Reason: stopMessage(found)}
}

// readTurn indexes a turn's edit rows. Commands are matched in order later.
func readTurn(rows []record.JournalEntry) stopTurn {
	t := stopTurn{rows: rows, lastEdit: map[string]int64{}, lastEditAt: map[string]time.Time{}}
	for _, r := range rows {
		switch {
		case r.Kind == "edit" && r.Text != "":
			t.lastEdit[r.Text] = r.ID
			if at, err := time.Parse(time.RFC3339Nano, r.TS); err == nil {
				t.lastEditAt[r.Text] = at
			}
		case r.Kind == "command":
			t.commands = true
		}
	}
	return t
}

// turnStart is when the turn began: the previous stop's time, else the
// session's start.
func turnStart(h *record.Hooks, ev contract.Event, cursor stopCursor) time.Time {
	if at, err := time.Parse(time.RFC3339Nano, cursor.At); err == nil {
		return at
	}
	if s, err := h.Session(ev.SessionID); err == nil && s != nil {
		if at, err := time.Parse(time.RFC3339Nano, s.StartedAt); err == nil {
			return at
		}
	}
	return time.Time{}
}

// supported: a rule the code no longer supports never sends the agent back,
// and a mined one needs a verdict that it holds today (as for the speed
// bump).
func supported(h *record.Hooks, ev contract.Event, e *entries.Entry) bool {
	v, ok, err := h.VerdictOf(ev.ProjectID, ev.Checkout, e.ID)
	if err != nil || (ok && (v.Verdict == broken || v.Verdict == changed)) {
		return false
	}
	return e.Evidence != "mined" || (ok && v.Verdict == held)
}

// ranAfter reports whether a command row after the row id after matches.
func (t stopTurn) ranAfter(after int64, match func(segment string) bool) bool {
	for _, r := range t.rows {
		if r.ID <= after || r.Kind != "command" {
			continue
		}
		for _, segment := range shellparse.Segments(r.Text) {
			if match(segment) {
				return true
			}
		}
	}
	return false
}

// ── CI obligations ──

// obligationFindings: knowledge-08's CI path obligations ("after changes in
// X, run Y") whose area the turn edited, where none of their commands ran
// after the last edit in that area. Ran, not passed (re-plan decision 8).
func obligationFindings(ev contract.Event, h *record.Hooks, snap *entries.Snapshot, turn stopTurn, state *bumpState) []stopFinding {
	var out []stopFinding
	for i := range snap.Items {
		it := &snap.Items[i]
		e := it.Entry
		if e == nil || e.Kind != "procedure" || e.Source.Type != "ci" || it.NeedsHintGate || state.Stopped[e.ID] {
			continue
		}
		commands := obligationCommands(e)
		if len(commands) == 0 {
			continue
		}
		var last int64
		var edited []string
		for rel, id := range turn.lastEdit {
			if inScope(it, rel) {
				edited = append(edited, rel)
				last = max(last, id)
			}
		}
		if len(edited) == 0 {
			continue
		}
		if turn.ranAfter(last, func(segment string) bool {
			for _, c := range commands {
				if sameCommand(segment, c) {
					return true
				}
			}
			return false
		}) {
			continue
		}
		if !supported(h, ev, e) {
			continue
		}
		sort.Strings(edited)
		out = append(out, stopFinding{rule: e.ID, files: edited, line: obligationLine(e, edited, commands)})
		if len(out) == stopMaxObligations {
			break
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].rule < out[j].rule })
	return out
}

// obligationCommands are the commands an obligation's command checks name.
func obligationCommands(e *entries.Entry) []string {
	var out []string
	for _, c := range e.Checks {
		if c.Kind != "command" {
			continue
		}
		if run, ok := c.Target["run"].(string); ok && strings.TrimSpace(run) != "" && !contains(out, run) {
			out = append(out, strings.TrimSpace(run))
		}
	}
	return out
}

func obligationLine(e *entries.Entry, edited, commands []string) string {
	run := make([]string, len(commands))
	for i, c := range commands {
		run[i] = "`" + c + "`"
	}
	where := ""
	if e.Source.Ref != "" {
		where = " in `" + e.Source.Ref + "`"
	}
	return fmt.Sprintf("You edited %s. CI runs %s%s for changes there, and %s not run since your last edit there. Run %s now. (%s)",
		namedFiles(edited), joinOr(run, "and"), where, pick(len(run), "it has", "they have"), joinOr(run, "and"), e.ID)
}

// sameCommand reports whether one shell segment runs an obligation's
// command. Whitespace and leading environment assignments are ignored, so
// are extra arguments after the command. A package script also matches when
// it ran through the same manager from inside its package (`cd
// packages/api && npm test` for `npm run -w packages/api test`).
func sameCommand(segment, command string) bool {
	got, want := commandWords(segment), commandWords(command)
	if len(got) == 0 || len(want) == 0 {
		return false
	}
	if len(got) >= len(want) && equalWords(got[:len(want)], want) {
		return true
	}
	gm, gs := scriptOf(got)
	wm, ws := scriptOf(want)
	return gs != "" && gm == wm && gs == ws
}

func commandWords(segment string) []string {
	words := shellparse.Words(strings.TrimSpace(segment))
	for len(words) > 0 && envAssignment(words[0]) {
		words = words[1:]
	}
	return words
}

func envAssignment(w string) bool {
	eq := strings.IndexByte(w, '=')
	if eq <= 0 {
		return false
	}
	for i, c := range w[:eq] {
		if !(c == '_' || c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || i > 0 && c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}

func equalWords(a, b []string) bool {
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

var scriptManagers = map[string]bool{"npm": true, "pnpm": true, "yarn": true, "bun": true}

// scriptFlagValues are the manager flags whose next word is a value, not the
// script.
var scriptFlagValues = map[string]bool{"-w": true, "--workspace": true, "--filter": true, "-F": true, "-C": true, "--dir": true, "--prefix": true, "--cwd": true}

// scriptOf names the manager and package script a command runs, or "".
func scriptOf(words []string) (manager, script string) {
	if len(words) < 2 || !scriptManagers[path.Base(words[0])] {
		return "", ""
	}
	manager = path.Base(words[0])
	for i := 1; i < len(words); i++ {
		w := words[i]
		switch {
		case w == "--":
			return "", ""
		case scriptFlagValues[w]:
			i++
		case strings.HasPrefix(w, "-"):
		case w == "run" || w == "run-script":
		case w == "workspace" && manager == "yarn":
			i++
		default:
			return manager, w
		}
	}
	return "", ""
}

// ── Direct tests ──

// directTestsFinding: the definitions this turn changed have tests that call
// them directly, and no test command after the last edit to those files ran
// the whole suite or named one of those tests. Silent without the file index
// or the graph, and for files an obligation that fired already covers.
func directTestsFinding(ev contract.Event, env Environment, turn stopTurn, obligations []stopFinding) (stopFinding, bool) {
	covered := map[string]bool{}
	for _, f := range obligations {
		for _, rel := range f.files {
			covered[rel] = true
		}
	}
	changed := map[string][]LineSpan{}
	var last int64
	for file, spans := range env.Changed {
		rel, ok := place.RelativeToCheckout(ev.Checkout, file)
		if !ok || covered[rel] {
			continue
		}
		id, editedNow := turn.lastEdit[rel]
		if !editedNow || graph.TestPath(rel) {
			continue
		}
		changed[rel] = append(changed[rel], spans...)
		last = max(last, id)
	}
	if len(changed) == 0 {
		return stopFinding{}, false
	}
	// A whole-suite run after the last edit settles it without the graph.
	if turn.ranAfter(last, fullTestCommand) {
		return stopFinding{}, false
	}
	view, ix, done := graphViewIndex(ev, env)
	if done == nil {
		return stopFinding{}, false
	}
	defer done()
	symbols := changedDefinitions(view, ix, changed)
	direct := directTests(view, symbols)
	if len(direct) == 0 {
		return stopFinding{}, false
	}
	if turn.ranAfter(last, func(segment string) bool { return testCommand(segment) && namesAny(segment, direct) }) {
		return stopFinding{}, false
	}
	names := make([]string, 0, len(symbols))
	for _, s := range symbols {
		if !contains(names, s.Name) {
			names = append(names, s.Name)
		}
	}
	line := fmt.Sprintf("You changed %s. No test run since your last edit included the %s that %s %s directly: %s. Run %s now.",
		namedFiles(names), pick(len(direct), "test", "tests"), pick(len(direct), "calls", "call"), pick(len(names), "it", "them"),
		namedFiles(direct), pick(len(direct), "it", "them"))
	return stopFinding{rule: stopTestsRule, line: line}, true
}

// directTests are the test files that call the changed definitions directly.
func directTests(view graph.View, symbols []graph.Symbol) []string {
	var out []string
	for _, def := range symbols {
		tests, err := view.R.Tests(def.ID)
		if err != nil {
			return nil
		}
		tests, _ = graph.KeepTests(tests, def.Name, view.R, view.Files, view.Src)
		for _, t := range tests {
			if t.Reach == graph.Direct && !contains(out, t.Test.Path) {
				out = append(out, t.Test.Path)
			}
		}
	}
	sort.Strings(out)
	return out
}

// namesAny reports a command word naming one of the test files: the path,
// a path ending in it, its folder, or its file name.
func namesAny(segment string, tests []string) bool {
	words := shellparse.Words(segment)
	if len(words) < 2 {
		return false
	}
	for _, w := range words[1:] {
		if strings.HasPrefix(w, "-") {
			continue
		}
		w = strings.TrimPrefix(path.Clean(strings.ReplaceAll(w, "\\", "/")), "./")
		if w == "." || w == "" {
			continue
		}
		for _, t := range tests {
			if t == w || strings.HasSuffix(t, "/"+w) || strings.HasPrefix(t, strings.TrimSuffix(w, "/")+"/") || path.Base(t) == w {
				return true
			}
		}
	}
	return false
}

// ── The reason ──

func stopMessage(found []stopFinding) string {
	var b strings.Builder
	b.WriteString("MEX is sending you back once before you finish. From what it saw this turn:")
	for _, f := range found {
		b.WriteString("\n\n- ")
		b.WriteString(f.line)
	}
	b.WriteString("\n\nIf a command can't run here, tell the person why instead of skipping it. MEX won't send you back for these again.")
	return b.String()
}

func namedFiles(files []string) string {
	shown := files
	if len(shown) > stopMaxNamed {
		shown = shown[:stopMaxNamed]
	}
	parts := make([]string, len(shown))
	for i, f := range shown {
		parts[i] = "`" + f + "`"
	}
	text := strings.Join(parts, ", ")
	if rest := len(files) - len(shown); rest > 0 {
		text += fmt.Sprintf(" and %d more", rest)
	}
	return text
}

func joinOr(items []string, word string) string {
	switch len(items) {
	case 0:
		return ""
	case 1:
		return items[0]
	}
	return strings.Join(items[:len(items)-1], ", ") + " " + word + " " + items[len(items)-1]
}

// pick is one for a count of one, else many.
func pick(n int, one, many string) string {
	if n == 1 {
		return one
	}
	return many
}

// ── The turn cursor ──

// stopCursor is the last journal row a stop in this session has read, and
// when that stop ran.
type stopCursor struct {
	Last int64  `json:"last"`
	At   string `json:"at,omitempty"`
}

func stopCursorPath(recordDirectory string, ev contract.Event) string {
	sum := sha256.Sum256([]byte(ev.Agent + "\x00" + ev.SessionID + "\x00" + ev.AgentID))
	return filepath.Join(recordDirectory, "stop-turn", hex.EncodeToString(sum[:12])+".json")
}

func loadStopCursor(file string) stopCursor {
	var c stopCursor
	if data, err := os.ReadFile(file); err == nil && len(data) < 4096 {
		_ = json.Unmarshal(data, &c)
	}
	c.Last = max(c.Last, 0)
	return c
}

func saveStopCursor(file string, c stopCursor) error {
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(c)
	if err != nil {
		return err
	}
	tmp := fmt.Sprintf("%s.%d.tmp", file, os.Getpid())
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, file); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}
