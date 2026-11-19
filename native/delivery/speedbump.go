package delivery

// The speed bump (plan sheet 31): before an edit runs, an edit that adds a
// strong rule's anti-pattern inside the rule's scope is stopped once, with
// the reason. If the agent makes such an edit again in the same epoch it
// passes, and the rule counts as deliberately changed. Only on agents whose
// pre-edit hook sees the new text and can deny: Claude Code's Edit and
// Write, Codex's apply_patch. Never on a crash, never twice for one rule in
// one epoch, never for a weak rule, never when the state can't be recorded.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/pattern"
	"github.com/mex-memory/mex/native/record"
)

const (
	// bumpOldBytes bounds the current file a Write is compared with.
	bumpOldBytes = 1 << 20
	// bumpMinLiteral is the shortest literal precise enough to stop an edit.
	bumpMinLiteral = 4
)

// strongEvidence: rules a person stated, or that come from docs, reviews or
// CI. Mined and observed ones are weak and never stop an edit.
var strongEvidence = map[string]bool{"person": true, "docs": true, "review": true, "ci": true}

type bump struct {
	item    *entries.Item
	trigger entries.Trigger
	rel     string
	project string
	check   string // checkout
}

// SpeedBump decides one pre-tool event. The empty reply lets the call run.
func SpeedBump(ev contract.Event, env Environment) contract.Reply {
	if ev.Kind != contract.PreTool || ev.Tool == nil || ev.SessionID == "" || env.RecordDirectory == "" {
		return contract.Reply{}
	}
	if !bumpTool(ev.Agent, ev.Tool.Name) {
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
	for _, b := range found {
		id := b.item.Entry.ID
		if v, ok, err := h.VerdictOf(b.project, b.check, id); err != nil || (ok && (v.Verdict == broken || v.Verdict == changed)) {
			continue // a rule the code no longer supports never stops an edit
		}
		if state.Stopped[id] {
			// The agent went ahead: this rule is being changed on purpose.
			if !state.Passed[id] {
				state.Passed[id] = true
				_ = state.save(file)
			}
			continue
		}
		state.Stopped[id] = true
		if state.save(file) != nil {
			return contract.Reply{} // without a record it could stop twice
		}
		return contract.Reply{Decision: contract.Deny, Reason: bumpReason(b, fullText(env, b))}
	}
	return contract.Reply{}
}

func bumpTool(agent string, tool contract.ToolName) bool {
	switch agent {
	case "claude-code":
		return tool == contract.ToolEdit || tool == contract.ToolWrite
	case "codex":
		return tool == contract.ToolPatch
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
			if !strongRule(it) || !inScope(it, v.rel) || !p.InEdit(added, it, "anti") {
				continue
			}
			for _, t := range it.Entry.When {
				if t.Type != "anti" || !precise(t) {
					continue
				}
				m, err := pattern.Matcher(t.Match, t.Pattern)
				if err != nil || !m(added) || m(old) {
					continue // only an edit that introduces the pattern
				}
				out = append(out, bump{item: it, trigger: t, rel: v.rel, project: v.project, check: v.checkout})
				break
			}
		}
	}
	return out
}

func strongRule(it *entries.Item) bool {
	e := it.Entry
	return e != nil && e.Kind == "rule" && e.Status == "active" && !it.NeedsHintGate && strongEvidence[e.Evidence]
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

// fullText is the stopped rule's full form, with its label and reason.
func fullText(env Environment, b bump) string {
	snap, err := entries.Load(env.RecordDirectory, env.Home, b.project, b.check)
	if err != nil {
		return ""
	}
	for i := range snap.Items {
		if snap.Items[i].Entry.ID == b.item.Entry.ID {
			return snap.Items[i].Full
		}
	}
	return ""
}

func bumpReason(b bump, full string) string {
	// The full form carries the label and the reason; without it, the one line.
	why := strings.TrimSpace(full)
	if why == "" {
		why = strings.TrimSpace(b.item.Entry.OneLine)
	}
	return fmt.Sprintf("MEX stopped this edit once. %s\n`%s` is added in %s. If this change is deliberate, make the edit again and it will go through.",
		why, b.trigger.Pattern, b.rel)
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
