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
	// The working-set choice is itself on trial: each session gets it or the
	// starting-folder choice by a stable hash, and the choice not sent is
	// recorded in shadow under its own surface, so the ledger compares two
	// randomized arms. `on` or `off` forces a choice; `shadow` sends the
	// folder choice and records the working-set one.
	mode := surfaceSetting(env, ev.ProjectID, workingSetSurface)
	var ws *workset.Set
	if mode != "off" {
		ws = workingSet(ev, env)
	}
	hints := hintGate(env.RecordDirectory, ev.ProjectID, ev.Agent, env.Now)
	result, err := brief.Build(brief.Options{Checkout: ev.Checkout, MexHome: env.Home, ProjectID: ev.ProjectID, Agent: ev.Agent, Path: area, RecordDirectory: env.RecordDirectory, SessionID: ev.SessionID, AgentID: ev.AgentID, NativeCwd: ev.Cwd, Deadline: time.Now().Add(100 * time.Millisecond),
		WorkingSet: ws, HintAllowed: func(id string) bool { return hints(&entries.Item{Entry: &entries.Entry{ID: id}}) }})
	if err != nil {
		return "", nil
	}
	if result.NativeStale {
		// Best effort: the background process rebuilds MEX's rule files
		// before the next session. The corrections cover this one.
		_ = RequestNativeRebuild(env.RecordDirectory, ev.ProjectID, ev.Checkout)
	}
	// Best effort: new commands, rule-file sections and agent memory reach
	// the agents from the next session, without anyone running mex again.
	_ = RequestSetupRefresh(env.RecordDirectory, ev.ProjectID, ev.Checkout, env.Now)
	req := baseRequest(ev, env, ev.ProjectID, ev.Checkout)
	req.OnceEntry = startMarker
	req.Candidates = []record.DeliveryCandidate{{EntryID: startMarker, Moment: "start-brief", Form: "one-line", Action: "given", Tokens: brief.TokenBound(brief.Priority) + 32, ContentHash: contentHash(brief.Priority)}}
	candidate := func(item brief.Item, surface string) record.DeliveryCandidate {
		return record.DeliveryCandidate{EntryID: item.ID, EntryHash: item.Hash, Moment: "start-brief", Surface: surface, Form: "one-line", Action: "given", Tokens: item.Tokens, ContentHash: contentHash(item.Hash + "\n" + item.Line), Target: record.SurfaceTarget{Scopes: item.Scopes}, Title: item.Line, Level: item.Level}
	}
	// Without a working set there is only the folder choice; it is sent as
	// before and nothing is compared.
	sent, other := result.Items, []brief.Item(nil)
	sentSurface, otherSurface := "start-brief", workingSetSurface
	lane := result.Lane
	if result.Folder != nil {
		useWorkingSet := mode == "on" || (mode == "trial" && record.TrialArm(ev.SessionID, ev.AgentID, workingSetSurface) == "on")
		if useWorkingSet {
			sent, other = result.Items, result.Folder
			sentSurface, otherSurface = workingSetSurface, "start-brief"
		} else {
			sent, other = result.Folder, append(append([]brief.Item{}, result.Items...), result.Lane...)
			lane = nil
		}
	}
	// The arm is already chosen; the folder choice keeps its own setting.
	sendMode := ""
	if sentSurface == workingSetSurface {
		sendMode = "on"
	}
	for _, item := range sent {
		c := candidate(item, sentSurface)
		c.Mode = sendMode
		req.Candidates = append(req.Candidates, c)
	}
	for i, item := range lane {
		c := candidate(item, sentSurface)
		c.Mode = sendMode
		if i == 0 {
			// The lane heading is part of what the first lane line costs.
			c.Tokens += brief.TokenBound("\n" + brief.LaneHeading)
		}
		req.Candidates = append(req.Candidates, c)
	}
	inSent := map[string]bool{}
	for _, item := range append(append([]brief.Item{}, sent...), lane...) {
		inSent[item.ID] = true
	}
	for _, item := range other {
		if !inSent[item.ID] {
			c := candidate(item, otherSurface)
			c.Mode = "shadow"
			req.Candidates = append(req.Candidates, c)
		}
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
	shown := result
	shown.Items, shown.Lane = sent, lane
	text := shown.Render(ids)
	_, body, _ := strings.Cut(text, "\n")
	return "[mex " + block + "]\n" + body, nil
}

// workingSetSurface is the start brief chosen by the working set; plain
// `start-brief` is the starting-folder choice.
const workingSetSurface = "start-brief-working-set"

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
