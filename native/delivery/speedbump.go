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
	"slices"
	"strings"
	"unicode/utf8"

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
	bumpReplyBytes = 10000
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
	noise := noiseReader{directory: env.RecordDirectory}
	defer noise.close()
	retirements := entries.Retirements{Directory: env.RecordDirectory}
	defer retirements.Close()
	epoch, _, err := h.CurrentEpoch(ev.SessionID, ev.AgentID)
	if err != nil {
		return contract.Reply{}
	}
	file := bumpStatePath(env.RecordDirectory, ev)
	state := loadBumpState(file, epoch.Number)
	full := map[string]map[[2]string]*entries.Item{}
	fullSnapshot := func(b bump) map[[2]string]*entries.Item {
		key := b.project + "\x00" + b.check
		if full[key] == nil {
			full[key] = map[[2]string]*entries.Item{}
			if snap, err := entries.Load(env.RecordDirectory, env.Home, b.project, b.check); err == nil {
				for i := range snap.Items {
					item := &snap.Items[i]
					full[key][[2]string{item.Level, item.Entry.ID}] = item
				}
			}
		}
		return full[key]
	}
	fullItem := func(b bump) *entries.Item {
		it := fullSnapshot(b)[[2]string{b.item.Level, b.item.Entry.ID}]
		if it == nil || it.Hash != b.item.Hash {
			return nil
		}
		return it
	}
	var stop []bump
	var overrides []bump
	seen := map[string]bool{}
	for _, b := range found {
		id := b.item.Entry.ID
		if seen[id] {
			continue
		}
		seen[id] = true
		if b.item.Entry.Learned() && noise.suppressed(b.project, id) {
			continue
		}
		if !retirements.Allows(b.project, b.item) {
			continue // dropped by the person: the note file stays, the record says so
		}
		v, ok, err := h.VerdictOf(b.project, b.check, id)
		if err != nil || (ok && (v.Verdict == broken || v.Verdict == changed)) {
			continue // a rule the code no longer supports never stops an edit
		}
		if b.item.Entry.Learned() {
			it := fullItem(b)
			if it == nil {
				continue
			}
			verdict := unknown
			if ok {
				verdict = v.Verdict
			}
			if !bumpGiven(h, env, b, it, verdict) {
				continue
			}
		}
		if b.item.Entry.Evidence == "mined" && !(ok && v.Verdict == held && completeCheck(fullItem(b))) {
			continue
		}
		if state.Stopped[id] {
			// The agent went ahead: this rule is being changed on purpose.
			if !state.Passed[id] {
				state.Passed[id] = true
				overrides = append(overrides, b)
			}
			continue
		}
		stop = append(stop, b)
	}
	if len(stop) == 0 {
		if len(overrides) > 0 && state.save(file) == nil {
			bumpReceipts(h, ev, env, epoch.Number, overrides, "control", "override")
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
	bumpReceipts(h, ev, env, epoch.Number, overrides, "control", "override")
	fullStops := map[[4]string]bool{}
	for _, b := range stop[:min(len(stop), bumpMaxReasons)] {
		fullStops[[4]string{b.project, b.check, b.item.Level, b.item.Entry.ID}] = true
	}
	companion := func(b bump, it *entries.Item) string {
		if b.trigger.Type != "rejected" || it == nil || !it.Entry.Learned() || it.Entry.Kind != "decision" {
			return ""
		}
		for _, id := range it.Entry.Companions {
			if id == it.Entry.ID || fullStops[[4]string{b.project, b.check, it.Level, id}] {
				continue
			}
			other := fullSnapshot(b)[[2]string{it.Level, id}]
			// A retired, missing or rewritten note cannot supply the other reason.
			if other == nil || other.Entry.Status != "active" || !other.Entry.Learned() || other.Entry.Kind != "decision" ||
				!slices.Contains(other.Entry.Companions, it.Entry.ID) || !slices.Contains(other.Entry.When, b.trigger) ||
				!retirements.Allows(b.project, other) {
				continue
			}
			v, ok, err := h.VerdictOf(b.project, b.check, id)
			if err != nil || (ok && (v.Verdict == broken || v.Verdict == changed)) {
				continue
			}
			verdict := unknown
			if ok {
				verdict = v.Verdict
			}
			if bumpGiven(h, env, b, other, verdict) {
				return strings.TrimSpace(other.Full)
			}
		}
		return ""
	}
	reply, shown := renderBump(stop, fullItem, companion)
	bumpReceipts(h, ev, env, epoch.Number, stop[:shown], "given", "")
	for _, b := range stop {
		noteViolation(env.RecordDirectory, b.project, b.item.Entry.ID, env.Now)
	}
	return contract.Reply{Decision: contract.Deny, Reason: reply}
}

func bumpGiven(h *record.Hooks, env Environment, b bump, item *entries.Item, verdict string) bool {
	senv := &shapeEnv{recordDirectory: env.RecordDirectory, project: b.project, checkout: b.check, hooks: h}
	defer senv.close()
	return shape(candidate{item: item}, verdict, senv).action == "given"
}

func bumpReceipts(h *record.Hooks, ev contract.Event, env Environment, epoch int, rules []bump, action, detail string) {
	requests := map[[2]string]*record.DeliveryRequest{}
	for _, b := range rules {
		e := b.item.Entry
		if !e.Learned() {
			continue
		}
		key := [2]string{b.project, b.check}
		req := requests[key]
		if req == nil {
			req = &record.DeliveryRequest{
				Session: record.Session{SessionID: ev.SessionID, Agent: ev.Agent, ProjectID: b.project, Checkout: b.check},
				AgentID: ev.AgentID, Now: env.Now, ExpectedEpoch: &epoch,
			}
			requests[key] = req
		}
		req.Candidates = append(req.Candidates, record.DeliveryCandidate{EntryID: e.ID, Moment: "bump",
			Form: "one-line", Action: action, Detail: detail, Kind: e.Kind, Level: b.item.Level, Mode: "on", Exempt: true, Resend: action == "given"})
	}
	for _, req := range requests {
		_, _ = h.CheckAndMark(*req)
	}
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
		// A Write sends the whole file. The prefix a hunk is bounded to would
		// hide a pattern added further down, while the file compared against
		// is read much further.
		limit := 32768
		old := v.removed
		if v.name == contract.ToolWrite {
			limit = bumpOldBytes
			old = currentText(v.path)
		}
		added := boundedText(v.added, limit)
		for _, m := range matchEdit(snap, v.rel, added, old) {
			m.project, m.check = v.project, v.checkout
			out = append(out, m)
		}
	}
	return out
}

// matchEdit finds the rules in snap whose anti-pattern (or rejected option)
// one edit adds at rel: added is the new text, old what it replaces. It is the
// speed bump's whole matching rule, shared with the "would have fired" replay
// so the two can never disagree.
func matchEdit(snap *entries.Snapshot, rel, added, old string) []bump {
	var out []bump
	p := snap.Patterns()
	for i := range snap.Items {
		it := &snap.Items[i]
		typ := bumpType(it)
		if typ == "anti" && len(it.Entry.When) == 0 {
			// A layer rule held by an import relation has no literal to
			// match: the edit's imports are resolved instead.
			if inScope(it, rel) {
				if t, ok := relationBump(it, rel, added, old); ok {
					out = append(out, bump{item: it, trigger: t, rel: rel})
				}
			}
			continue
		}
		if typ == "" || !p.InEdit(added, it, typ) {
			continue
		}
		// A rule within its scope; a rejected option within the decision's
		// scope or in a manifest, where a dependency comes back.
		if !inScope(it, rel) && !(typ == "rejected" && isManifest(rel)) {
			continue
		}
		for _, t := range it.Entry.When {
			if t.Type != typ || !precise(t) {
				continue
			}
			if occurrences(t, added) <= occurrences(t, old) {
				continue // only an edit that adds the pattern
			}
			out = append(out, bump{item: it, trigger: t, rel: rel})
			break
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

const bumpIntro = "MEX stopped this edit once. "
const bumpTail = ", unless the person asked for exactly this. If they did, make the edit again and it will go through, and tell them it goes against what the team recorded."

func renderBump(stop []bump, fullItem func(bump) *entries.Item, companion func(bump, *entries.Item) string) (string, int) {
	terms := "it"
	if len(stop) > 1 {
		terms = "them"
	}
	tail := "\nChange the edit to follow " + terms + bumpTail
	// Reserve room to name omitted rules when an unusually large batch hits.
	room := bumpReplyBytes - len(bumpIntro) - len(tail) - 64
	fullCount := min(len(stop), bumpMaxReasons)
	perReason := (room-min(1024, 128*(len(stop)-fullCount)))/fullCount - 2
	var reasons []string
	for i, b := range stop {
		var full *entries.Item
		limit := room
		related := ""
		if i < fullCount {
			full, limit = fullItem(b), perReason
			if why := companion(b, full); why != "" {
				const prefix = "\nRelated reason: "
				related = prefix + shorten(why, limit/2-len(prefix))
			}
		}
		reason := bumpReason(b, full, limit-len(related))
		if reason == "" || len(reason)+len(related)+2 > room {
			break
		}
		reasons = append(reasons, reason+related)
		room -= len(reason) + len(related) + 2
	}
	shown := len(reasons)
	if shown < len(stop) {
		reasons = append(reasons, fmt.Sprintf("%d more rules matched.", len(stop)-shown))
	}
	return bumpIntro + strings.Join(reasons, "\n\n") + tail, shown
}

func bumpReason(b bump, full *entries.Item, limit int) string {
	e := b.item.Entry
	why := strings.TrimSpace(e.OneLine)
	what := "is added"
	if b.trigger.Type == "rejected" {
		what = "brings back a rejected option"
	}
	where := fmt.Sprintf("\n`%s` %s in %s.", b.trigger.Pattern, what, b.rel)
	if len(where) > limit/2 {
		where = shorten(where, limit/2)
	}
	source := ""
	if e.Learned() {
		source = "\nLearned from " + learnedEvidence(e.Source.Label) + " \u00b7 `mex recall " + e.ID + "`"
	}
	if len(where)+len(source) >= limit {
		return ""
	}
	limit -= len(where) + len(source)
	fix := ""
	if full != nil {
		if strings.TrimSpace(full.Full) != "" {
			why = strings.TrimSpace(full.Full)
		}
		if f := full.Entry.Fix; f != nil {
			fix = bumpFix(f, min(limit/2, max(limit-len(why), 600)))
		}
	}
	return shorten(why, limit-len(fix)) + where + fix + source
}

var reviewCount = lazy(`(?i)\bfrom ([1-9][0-9]*) (?:PRs?|reviews?)\b`)

func learnedEvidence(label string) string {
	if m := reviewCount().FindStringSubmatch(label); m != nil {
		if m[1] == "1" {
			return "1 PR review"
		}
		return m[1] + " PR reviews"
	}
	if label != "" {
		return strings.TrimSpace(strings.TrimPrefix(label, "Learned from "))
	}
	return "recorded evidence"
}

func shorten(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	if limit < 3 {
		return ""
	}
	end := limit - 3
	for end > 0 && !utf8.RuneStart(text[end]) {
		end--
	}
	return strings.TrimSpace(text[:end]) + "..."
}

var backtickRuns = lazy("`+")

func bumpFix(f *entries.Fix, limit int) string {
	head := "\nDo this instead (from `" + f.Path + "`):"
	trimmed := " (trimmed)"
	lines := strings.Split(strings.TrimSuffix(f.Snippet, "\n"), "\n")
	for n := len(lines); n > 0; n-- {
		code := strings.Join(lines[:n], "\n")
		fenceLen := 3
		for _, run := range backtickRuns().FindAllString(code, -1) {
			fenceLen = max(fenceLen, len(run)+1)
		}
		fence := strings.Repeat("`", fenceLen)
		header := head
		if n < len(lines) {
			header += trimmed
		}
		text := header + "\n" + fence + "\n" + code + "\n" + fence
		if len(text) <= limit {
			return text
		}
	}
	if len(head)+len(trimmed) <= limit {
		return head + trimmed
	}
	return ""
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
