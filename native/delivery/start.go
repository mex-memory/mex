package delivery

import (
	"path/filepath"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/brief"
	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
	"github.com/mex-memory/mex/native/workset"
)

// Outside the canonical mx_ namespace, so a real entry cannot collide with it.
const startMarker = "mex:start-brief"

// startBlock fills the lifecycle's start slot using the same CheckAndMark
// transaction as moment delivery. Its marker and entry receipts debit one
// ledger, so resumes and parallel starts cannot send a different brief.
func startBlock(h *record.Hooks, ev contract.Event, env Environment) (string, error) {
	if ev.AgentID != "" {
		return "", nil
	}
	cwd, err := place.RealPath(ev.Cwd)
	if err != nil {
		return "", nil // unavailable source cannot authorize a brief
	}
	area := ""
	if filepath.Clean(cwd) != filepath.Clean(ev.Checkout) {
		var ok bool
		area, ok = place.RelativeToCheckout(ev.Checkout, cwd)
		if !ok {
			return "", nil
		}
	}
	ws := workingSet(ev, env)
	hints := hintGate(env.RecordDirectory, ev.ProjectID, ev.Agent, env.Now)
	result, err := brief.Build(brief.Options{Checkout: ev.Checkout, MexHome: env.Home, ProjectID: ev.ProjectID, Agent: ev.Agent, Path: area, RecordDirectory: env.RecordDirectory, SessionID: ev.SessionID, AgentID: ev.AgentID, NativeCwd: ev.Cwd, Deadline: time.Now().Add(100 * time.Millisecond),
		WorkingSet: ws, HintAllowed: func(id string) bool { return hints(&entries.Item{Entry: &entries.Entry{ID: id}}) }})
	if err != nil {
		return "", nil
	}
	req := baseRequest(ev, env, ev.ProjectID, ev.Checkout)
	req.OnceEntry = startMarker
	req.Candidates = []record.DeliveryCandidate{{EntryID: startMarker, Moment: "start-brief", Form: "one-line", Action: "given", Tokens: brief.TokenBound(brief.Priority) + 32, ContentHash: contentHash(brief.Priority)}}
	candidate := func(item brief.Item, surface string) record.DeliveryCandidate {
		return record.DeliveryCandidate{EntryID: item.ID, Moment: "start-brief", Surface: surface, Form: "one-line", Action: "given", Tokens: item.Tokens, ContentHash: contentHash(item.Hash + "\n" + item.Line), Target: record.SurfaceTarget{Scopes: item.Scopes}, Title: item.Line, Level: item.Level}
	}
	for _, item := range result.Items {
		req.Candidates = append(req.Candidates, candidate(item, "start-brief"))
	}
	if len(result.Lane) > 0 {
		// The lane heading is part of what the first lane line costs.
		first := candidate(result.Lane[0], "start-brief")
		first.Tokens += brief.TokenBound("\n" + brief.LaneHeading)
		req.Candidates = append(req.Candidates, first)
		for _, item := range result.Lane[1:] {
			req.Candidates = append(req.Candidates, candidate(item, "start-brief"))
		}
	}
	// What the area selection would have sent: logged under its own surface,
	// which stays in shadow, so the ledger can compare the two selections.
	for _, item := range result.Previous {
		req.Candidates = append(req.Candidates, candidate(item, "start-brief-previous"))
	}
	res, err := h.CheckAndMark(req)
	if err != nil {
		return "", err
	}
	var ids []string
	block := ""
	for _, r := range res.Receipts {
		if r.Action != "given" {
			continue
		}
		if r.EntryID == startMarker {
			block = r.BlockID
		} else {
			ids = append(ids, r.EntryID)
		}
	}
	if block == "" {
		return "", nil
	}
	text := result.Render(ids)
	_, body, _ := strings.Cut(text, "\n")
	return "[mex " + block + "]\n" + body, nil
}

// workingSet reads the checkout's cached working set and, when it is missing
// or behind, asks the background process for a new one. It never waits and
// never runs git: a set computed at an older commit of the same branch is
// still close, and one from another branch is not used at all.
func workingSet(ev contract.Event, env Environment) *workset.Set {
	ws := workset.Read(env.RecordDirectory, ev.ProjectID, ev.Checkout)
	branch, commit := workset.Head(ev.Checkout)
	if ws.Stale(branch, commit, env.Now) {
		_ = workset.Request(env.RecordDirectory, ev.ProjectID, ev.Checkout)
	}
	if !ws.Usable(branch) {
		return nil
	}
	return ws
}
