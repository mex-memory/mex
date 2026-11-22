package delivery

// The speed bump (plan sheet 31): before an edit runs, an edit that adds a
// strong rule's anti-pattern inside the rule's scope, or brings back an
// option a decision rejected, is stopped once, with the reason. If the agent
// makes such an edit again in the same epoch it passes, and the rule counts
// as deliberately changed. On every agent whose pre-edit hook sees the new
// text and can deny (the caller checks the agent's profile). Never on a
// crash, never twice for one rule in one epoch, never twice for one edit,
// never for a weak rule, never when the state can't be recorded.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/internal/contract"
	pathscope "github.com/mex-memory/mex/native/internal/scope"
	"github.com/mex-memory/mex/native/pattern"
	"github.com/mex-memory/mex/native/record"
)

const (
	// bumpOldBytes bounds the current file a Write is compared with.
	bumpOldBytes = 1 << 20
	// bumpMinLiteral is the shortest literal precise enough to stop an edit.
	bumpMinLiteral = 4
	// bumpMaxReasons bounds the rules one stop names in full; any more are
	// named by their one line.
	bumpMaxReasons = 3
)

// strongEvidence: rules a person stated, or that come from docs, reviews or
// CI. Observed ones never stop an edit. Mined ones (a layer rule found in the
// code) stop one only while the code agrees with them in full: a complete
// check that holds today.
var strongEvidence = map[string]bool{"person": true, "docs": true, "review": true, "ci": true}

type bump struct {
	item    *entries.Item
	trigger entries.Trigger
	rel     string
	project string
	check   string // checkout
}

// SpeedBump decides one pre-tool event. The empty reply lets the call run.
// The caller passes only events from agents whose profile can deny a tool.
func SpeedBump(ev contract.Event, env Environment) contract.Reply {
	if ev.Kind != contract.PreTool || ev.Tool == nil || ev.SessionID == "" || env.RecordDirectory == "" {
		return contract.Reply{}
	}
	if t := ev.Tool.Name; t != contract.ToolEdit && t != contract.ToolWrite && t != contract.ToolPatch {
		return contract.Reply{}
	}
	found := bumpCandidates(ev, env)
	if len(found) == 0 {
		return contract.Reply{}
	}
	h, err := record.OpenHooks(record.Location{Directory: env.RecordDirectory, Hooks: filepath.Join(env.RecordDirectory, "hooks.db")})
	if err != nil {
		return contract.Reply{}
	}
	defer h.Close()
	epoch, _, err := h.CurrentEpoch(ev.SessionID, ev.AgentID)
	if err != nil {
		return contract.Reply{}
	}
	file := bumpStatePath(env.RecordDirectory, ev)
	state := loadBumpState(file, epoch.Number)
	var full map[string]*entries.Item // loaded once, only when needed
	fullItem := func(b bump) *entries.Item {
		if full == nil {
			full = map[string]*entries.Item{}
			if snap, err := entries.Load(env.RecordDirectory, env.Home, b.project, b.check); err == nil {
				for i := range snap.Items {
					full[snap.Items[i].Entry.ID] = &snap.Items[i]
				}
			}
		}
		return full[b.item.Entry.ID]
	}
	var stop []bump
	passed, seen := false, map[string]bool{}
	for _, b := range found {
		id := b.item.Entry.ID
		if seen[id] {
			continue
		}
		seen[id] = true
		v, ok, err := h.VerdictOf(b.project, b.check, id)
		if err != nil || (ok && (v.Verdict == broken || v.Verdict == changed)) {
			continue // a rule the code no longer supports never stops an edit
		}
		if b.item.Entry.Evidence == "mined" && !(ok && v.Verdict == held && completeCheck(fullItem(b))) {
			continue
		}
		if state.Stopped[id] {
			// The agent went ahead: this rule is being changed on purpose.
			if !state.Passed[id] {
				state.Passed[id], passed = true, true
			}
			continue
		}
		stop = append(stop, b)
	}
	if len(stop) == 0 {
		if passed {
			_ = state.save(file)
		}
		return contract.Reply{}
	}
	// One stop names every rule this edit breaks, so making the edit again
	// never meets a second stop.
	for _, b := range stop {
		state.Stopped[b.item.Entry.ID] = true
	}
	if state.save(file) != nil {
		return contract.Reply{} // without a record it could stop twice
	}
	reasons := make([]string, 0, len(stop))
	for i, b := range stop {
		noteViolation(env.RecordDirectory, b.project, b.item.Entry.ID, env.Now)
		text := ""
		if i < bumpMaxReasons {
			if it := fullItem(b); it != nil {
				text = it.Full
			}
		}
		reasons = append(reasons, bumpReason(b, text))
	}
	return contract.Reply{Decision: contract.Deny, Reason: bumpMessage(reasons)}
}

// completeCheck: the entry carries a check that pins its whole claim.
func completeCheck(it *entries.Item) bool {
	if it == nil || it.Entry == nil {
		return false
	}
	for _, c := range it.Entry.Checks {
		if c.Role == "complete" {
			return true
		}
	}
	return false
}

// bumpCandidates finds, without opening any database, the strong rules whose
// anti-pattern the call adds in scope. One snapshot per checkout.
func bumpCandidates(ev contract.Event, env Environment) []bump {
	var out []bump
	snaps := map[string]*entries.Snapshot{}
	for _, v := range views(ev, env.Resolve) {
		if !isEdit(v) || v.checkout == "" || v.project == "" || v.rel == "" || v.added == "" {
			continue
		}
		key := v.project + "\x00" + v.checkout
		snap, ok := snaps[key]
		if !ok {
			// Light: scopes, patterns and evidence, no text. Text is loaded
			// only for an edit that is stopped.
			loaded, err := entries.LoadLight(env.RecordDirectory, env.Home, v.project, v.checkout)
			if err == nil {
				snap = &loaded
			}
			snaps[key] = snap
		}
		if snap == nil {
			continue
		}
		added := boundedText(v.added, 32768)
		old := v.removed
		if v.name == contract.ToolWrite {
			old = currentText(v.path)
		}
		p := snap.Patterns()
		for i := range snap.Items {
			it := &snap.Items[i]
			typ := bumpType(it)
			if typ == "anti" && len(it.Entry.When) == 0 {
				// A layer rule held by an import relation has no literal to
				// match: the edit's imports are resolved instead.
				if inScope(it, v.rel) {
					if t, ok := relationBump(it, v.rel, added, old); ok {
						out = append(out, bump{item: it, trigger: t, rel: v.rel, project: v.project, check: v.checkout})
					}
				}
				continue
			}
			if typ == "" || !p.InEdit(added, it, typ) {
				continue
			}
			// A rule within its scope; a rejected option within the decision's
			// scope or in a manifest, where a dependency comes back.
			if !inScope(it, v.rel) && !(typ == "rejected" && isManifest(v.rel)) {
				continue
			}
			for _, t := range it.Entry.When {
				if t.Type != typ || !precise(t) {
					continue
				}
				if occurrences(t, added) <= occurrences(t, old) {
					continue // only an edit that adds the pattern
				}
				out = append(out, bump{item: it, trigger: t, rel: v.rel, project: v.project, check: v.checkout})
				break
			}
		}
	}
	return out
}

// importSpec is the module an import, export-from, dynamic import or
// require names.
var importSpec = lazy(`(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"'\n]+)["']`)

// relationBump finds, for a rule held by an import relation ("core never
// imports app": a complete relation check), an import the edit adds from a
// file in the rule's from scope into its to scope. Imports are resolved as
// the file index resolves them, relative to the edited file; package imports
// name no folder here and never stop an edit.
func relationBump(it *entries.Item, rel, added, old string) (entries.Trigger, bool) {
	for _, c := range it.Entry.Checks {
		query, _ := c.Target["query"].(string)
		from, _ := c.Target["from"].(string)
		to, _ := c.Target["to"].(string)
		if c.Kind != "relation" || c.Role != "complete" || query != "imports" || from == "" || to == "" {
			continue
		}
		fromRE, err := pathscope.CompileGlob(pathscope.Normalize(from))
		if err != nil || !fromRE.MatchString(rel) {
			continue
		}
		toRE, err := pathscope.CompileGlob(pathscope.Normalize(to))
		if err != nil {
			continue
		}
		before := importsInto(rel, old, toRE)
		for spec, n := range importsInto(rel, added, toRE) {
			if n > before[spec] {
				return entries.Trigger{Type: "anti", Match: "literal", Pattern: spec}, true
			}
		}
	}
	return entries.Trigger{}, false
}

// importsInto counts the relative imports in text, from file, that resolve
// into the to scope (a folder import reaches its index file).
func importsInto(file, text string, to *regexp.Regexp) map[string]int {
	out := map[string]int{}
	if text == "" {
		return out
	}
	for _, m := range importSpec().FindAllStringSubmatch(text, 256) {
		spec := m[1]
		if !strings.HasPrefix(spec, "./") && !strings.HasPrefix(spec, "../") {
			continue
		}
		target := path.Clean(path.Join(path.Dir(file), spec))
		if target == ".." || strings.HasPrefix(target, "../") {
			continue
		}
		if to.MatchString(target) || to.MatchString(target+"/index.ts") {
			out[spec]++
		}
	}
	return out
}

// bumpType is the trigger type that can stop an edit for this entry: a
// strong rule's anti-pattern, or a strong decision's rejected option. ""
// when the entry can't stop one.
func bumpType(it *entries.Item) string {
	e := it.Entry
	if e == nil || e.Status != "active" || it.NeedsHintGate || !(strongEvidence[e.Evidence] || e.Evidence == "mined") {
		return ""
	}
	switch e.Kind {
	case "rule":
		return "anti"
	case "decision":
		return "rejected"
	}
	return ""
}

// occurrences counts a pattern in text: an edit adds it when the new text
// has more than the text it replaces, so moving or re-indenting code that
// already had it, or editing beside an existing use, never stops.
func occurrences(t entries.Trigger, text string) int {
	if text == "" {
		return 0
	}
	if t.Match == "literal" {
		return strings.Count(text, t.Pattern)
	}
	return len(pattern.Spans(t.Match, t.Pattern, text))
}

// precise: a literal long enough not to fire by accident, or a structural
// pattern that names at least one word.
func precise(t entries.Trigger) bool {
	switch t.Match {
	case "literal":
		return len(strings.TrimSpace(t.Pattern)) >= bumpMinLiteral
	case "structural":
		s, err := pattern.CompileStructural(t.Pattern)
		return err == nil && s.Words() > 0
	}
	return false
}

// currentText is the file a Write replaces, so an anti-pattern it already
// had isn't counted as introduced. A file that can't be read counts as new.
func currentText(path string) string {
	f, err := os.Open(filepath.FromSlash(path))
	if err != nil {
		return ""
	}
	defer f.Close()
	data, _ := io.ReadAll(io.LimitReader(f, bumpOldBytes))
	return string(data)
}

// bumpReason is one stopped rule: its full form (label and reason) when
// given, else its one line, and what the edit adds where.
func bumpReason(b bump, full string) string {
	why := strings.TrimSpace(full)
	if why == "" {
		why = strings.TrimSpace(b.item.Entry.OneLine)
	}
	what := "is added"
	if b.trigger.Type == "rejected" {
		what = "brings back a rejected option"
	}
	return fmt.Sprintf("%s\n`%s` %s in %s.", why, b.trigger.Pattern, what, b.rel)
}

// The last line makes following the rule the default. Asked only "if
// deliberate", models in the live test repeated a pasted snippet at once and
// told nobody; the person's explicit request still wins.
func bumpMessage(reasons []string) string {
	it := "it"
	if len(reasons) > 1 {
		it = "them"
	}
	return "MEX stopped this edit once. " + strings.Join(reasons, "\n\n") +
		"\nChange the edit to follow " + it + ", unless the person asked for exactly this. If they did, make the edit again and it will go through, and tell them it goes against what the team recorded."
}

// bumpState is kept per session and agent, and reset when the epoch moves.
type bumpState struct {
	Epoch   int             `json:"epoch"`
	Stopped map[string]bool `json:"stopped"`
	Passed  map[string]bool `json:"passed"` // stopped, then repeated: deliberate
}

func bumpStatePath(recordDirectory string, ev contract.Event) string {
	sum := sha256.Sum256([]byte(ev.Agent + "\x00" + ev.SessionID + "\x00" + ev.AgentID))
	return filepath.Join(recordDirectory, "speed-bump", hex.EncodeToString(sum[:12])+".json")
}

func loadBumpState(file string, epoch int) *bumpState {
	s := &bumpState{}
	if data, err := os.ReadFile(file); err == nil && len(data) < 1<<20 {
		_ = json.Unmarshal(data, s)
	}
	if s.Epoch != epoch || s.Stopped == nil {
		s = &bumpState{Epoch: epoch, Stopped: map[string]bool{}, Passed: map[string]bool{}}
	}
	if s.Passed == nil {
		s.Passed = map[string]bool{}
	}
	return s
}

// save writes a new file and renames it into place, so a reader never sees
// half of one.
func (s *bumpState) save(file string) error {
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return err
	}
	data, err := json.Marshal(s)
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

// Deliberate lists the rules the agent went past a speed bump for in the
// current epoch: those are being changed on purpose.
func Deliberate(recordDirectory string, ev contract.Event, epoch int) map[string]bool {
	if recordDirectory == "" || ev.SessionID == "" {
		return nil
	}
	return loadBumpState(bumpStatePath(recordDirectory, ev), epoch).Passed
}
