package delivery

import (
	"strings"

	"github.com/mex-memory/mex/native/brief"
	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record"
)

// Session life (sheet 31): what the agent gets when its context changes
// under it. Each block is small and built from what the ledger says the agent
// was given; nothing here is a new moment.

const (
	recoveryBudget = 400
	subagentBrief  = 600
	maxIDList      = 20
)

// readOnlyAgents are subagent types that only look: they get moment items,
// never the brief. Unknown types are treated as editing, the safer side for
// a brief of one-liners.
var readOnlyAgents = map[string]bool{"explore": true, "plan": true, "claude-code-guide": true, "statusline-setup": true}

// lifecycleBlock builds the recovery block (after compaction), the resume
// corrections, or the subagent brief, and records them in the ledger.
func lifecycleBlock(h *record.Hooks, ev contract.Event, env Environment, reason string, signal int, epoch record.Epoch) (string, error) {
	switch {
	case reason == "startup" || reason == "clear" || reason == "fork":
		return startBlock(h, ev, env)
	case reason == "compact" && signal == 1 && epoch.Number > 0:
		return recovery(h, ev, env, epoch.Number-1)
	case reason == "resume":
		return resumeCorrections(h, ev, env)
	case reason == "subagent" && !readOnlyAgents[strings.ToLower(ev.AgentType)]:
		return subagentStartBrief(h, ev, env)
	}
	return "", nil
}

type known struct {
	snap  *entries.Snapshot
	byID  map[string]*entries.Item
	senv  *shapeEnv
	h     *record.Hooks
	ev    contract.Event
	cache map[string]string
}

func loadKnown(h *record.Hooks, ev contract.Event, env Environment) (*known, error) {
	snap, err := entries.Load(env.RecordDirectory, env.Home, ev.ProjectID, ev.Checkout)
	if err != nil {
		return nil, err
	}
	k := &known{snap: &snap, byID: map[string]*entries.Item{}, senv: &shapeEnv{recordDirectory: env.RecordDirectory, project: ev.ProjectID, checkout: ev.Checkout, hooks: h}, h: h, ev: ev, cache: map[string]string{}}
	for i := range snap.Items {
		k.byID[snap.Items[i].Entry.ID] = &snap.Items[i]
	}
	for _, imported := range brief.ReadImported(brief.Options{Checkout: ev.Checkout, MexHome: env.Home, ProjectID: ev.ProjectID}) {
		it := imported
		k.byID[it.Entry.ID] = &it
	}
	return k, nil
}

func (k *known) verdict(id string) string {
	if v, ok := k.cache[id]; ok {
		return v
	}
	v, ok, err := k.h.VerdictOf(k.ev.ProjectID, k.ev.Checkout, id)
	out := unknown
	if err == nil && ok {
		out = v.Verdict
	}
	k.cache[id] = out
	return out
}

// oneLine is what an earlier delivery becomes now: the current one-line form,
// a pointer or a re-derived recipe, or nothing when the verdict withholds it.
func (k *known) oneLine(id, moment string) (shaped, bool) {
	it := k.byID[id]
	if it == nil {
		return shaped{}, false
	}
	s := shape(candidate{item: it, moment: moment, tier: tierFile, exempt: true}, k.verdict(id), k.senv)
	if s.action == "withheld" || s.lineTok == 0 {
		return shaped{}, false
	}
	return s, true
}

// commit records a lifecycle block's items and renders what the ledger gave.
func commit(h *record.Hooks, ev contract.Event, env Environment, header string, plan []planned, tail string) (string, error) {
	if len(plan) == 0 {
		return "", nil
	}
	req := baseRequest(ev, env, ev.ProjectID, ev.Checkout)
	req.Candidates = requestCandidates(plan)
	surfaceTargets(plan, nil, req.Candidates)
	res, err := h.CheckAndMark(req)
	if err != nil || len(res.Receipts) == 0 {
		return "", err
	}
	body := render(res.Receipts[0].BlockID, plan, res.Receipts)
	if body == "" {
		return "", nil
	}
	marker, rest, _ := strings.Cut(body, "\n")
	out := marker + "\n" + header + "\n" + rest
	if tail != "" {
		out += "\n" + tail
	}
	return out, nil
}

// recovery: after compaction, one-line forms of the entries given in the
// previous epoch whose scope covers a file edited in it, verdicts re-checked,
// within 400 tokens, plus the ids of the rest. Everything else comes back at
// its next moment.
func recovery(h *record.Hooks, ev contract.Event, env Environment, previous int) (string, error) {
	given, _, err := h.EpochSelected(ev.SessionID, ev.AgentID, ev.ProjectID, ev.Checkout, previous, surfaceSetting(env, ev.ProjectID, "recovery") == "shadow")
	if err != nil || len(given) == 0 {
		return "", err
	}
	files, err := h.EpochFiles(ev.SessionID, ev.AgentID, ev.ProjectID, ev.Checkout, previous)
	if err != nil {
		return "", err
	}
	k, err := loadKnown(h, ev, env)
	if err != nil {
		return "", err
	}
	defer k.senv.close()
	var plan []planned
	var rest []string
	used := 0
	for i := len(given) - 1; i >= 0; i-- { // newest first
		g := given[i]
		it := k.byID[g.EntryID]
		if it == nil || !coversAny(it, files) {
			if it != nil && k.verdict(g.EntryID) != broken {
				rest = append(rest, g.EntryID)
			}
			continue
		}
		s, ok := k.oneLine(g.EntryID, "recovery")
		if !ok {
			continue
		}
		if used+s.lineTok > recoveryBudget {
			rest = append(rest, g.EntryID)
			continue
		}
		used += s.lineTok
		plan = append(plan, planned{shaped: s, form: "one-line", text: s.oneLine, tokens: s.lineTok})
	}
	tail := ""
	if len(rest) > 0 {
		if len(rest) > maxIDList {
			rest = rest[:maxIDList]
		}
		tail = "Also given before compaction, back when they apply: " + strings.Join(rest, ", ") + "."
	}
	return commit(h, ev, env, brief.Priority+"\nMEX notes for the files you were editing:", plan, tail)
}

func coversAny(it *entries.Item, files []string) bool {
	for _, f := range files {
		if inScope(it, f) {
			return true
		}
		if it.Level == "rule-file" {
			for _, scope := range it.Entry.Scope {
				if index.MatchesScope(scope, f) {
					return true
				}
			}
		}
	}
	return false
}

// resumeCorrections: the agent replays its own history on resume, so nothing
// is sent again. An entry given in this epoch that is now broken or gone gets
// a correction; one whose text changed gets its new one-line form.
func resumeCorrections(h *record.Hooks, ev contract.Event, env Environment) (string, error) {
	given, _, err := h.EpochSelected(ev.SessionID, ev.AgentID, ev.ProjectID, ev.Checkout, -1, surfaceSetting(env, ev.ProjectID, "recovery") == "shadow")
	if err != nil || len(given) == 0 {
		return "", err
	}
	k, err := loadKnown(h, ev, env)
	if err != nil {
		return "", err
	}
	defer k.senv.close()
	var plan []planned
	used := 0
	for _, g := range given {
		if g.EntryID == startMarker {
			continue
		}
		it := k.byID[g.EntryID]
		var p planned
		switch {
		case it == nil || k.verdict(g.EntryID) == broken:
			stub := &entries.Item{Entry: &entries.Entry{ID: g.EntryID}}
			p = planned{shaped: shaped{candidate: candidate{item: stub, moment: "correction", reserve: true}}, form: "one-line", tokens: 20, correction: true}
		case g.Moment != "recovery" && (g.Form == "full" || g.Form == "one-line"):
			text := it.OneLine
			if g.Form == "full" {
				text = it.Full
			}
			if contentHash(it.Hash+"\n"+text) == g.ContentHash {
				continue
			}
			s, ok := k.oneLine(g.EntryID, "correction")
			if !ok {
				continue
			}
			p = planned{shaped: s, form: "one-line", text: "Updated: " + s.oneLine, tokens: s.lineTok + 2, correction: true}
		default:
			continue
		}
		if used+p.tokens > reservedLane {
			continue
		}
		used += p.tokens
		plan = append(plan, p)
	}
	return commit(h, ev, env, "MEX notes changed since they were given:", plan, "")
}

// An editing subagent starts with the parent's priority line and one-liners of what the
// parent was given this epoch, within its own 600-token budget.
func subagentStartBrief(h *record.Hooks, ev contract.Event, env Environment) (string, error) {
	given, _, err := h.EpochSelected(ev.SessionID, "", ev.ProjectID, ev.Checkout, -1, surfaceSetting(env, ev.ProjectID, "recovery") == "shadow")
	if err != nil || len(given) == 0 {
		return "", err
	}
	k, err := loadKnown(h, ev, env)
	if err != nil {
		return "", err
	}
	defer k.senv.close()
	var plan []planned
	used := entries.EstimateTokens(brief.Priority)
	for i := len(given) - 1; i >= 0; i-- {
		s, ok := k.oneLine(given[i].EntryID, "brief")
		if !ok || used+s.lineTok > subagentBrief {
			continue
		}
		used += s.lineTok
		plan = append(plan, planned{shaped: s, form: "one-line", text: s.oneLine, tokens: s.lineTok})
	}
	return commit(h, ev, env, brief.Priority+"\nMEX notes the main session has for this work:", plan, "")
}
