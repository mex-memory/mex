// Package delivery owns context admission: one controller per context epoch
// decides what the agent gets and when. It is silent by default; a note goes
// out only when its moment comes, every hard gate passes and its verdict
// allows it, and the ledger records it in the same transaction that admits it.
package delivery

import (
	"errors"
	"path/filepath"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/brief"
	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/internal/safefile"
	"github.com/mex-memory/mex/native/record"
)

type Environment struct {
	Home, RecordDirectory string
	Now                   time.Time
	KeepSession           func(agent, sessionID string) bool
	// Resolve finds the registered checkout of a touched path; nil means
	// every tool uses the event's own checkout.
	Resolve Resolver
}

// EpochBudget uses conservative window anchors. An absent or unknown model
// gets the 200k default; an explicit 1m model variant gets the larger anchor.
// Keep model/window selection isolated for future profile capability tables.
func EpochBudget(model string, subagent bool) int {
	if subagent {
		return 600
	}
	if strings.Contains(strings.ToLower(model), "[1m]") {
		return 3000
	}
	return 2000
}

// lifecycle maps an event to the epoch change it causes, if any.
func lifecycle(ev contract.Event) (reason string, signal int, ok bool) {
	switch ev.Kind {
	case contract.SessionStart:
		switch ev.Source {
		case "", "startup":
			return "startup", 0, true
		case "resume", "clear", "fork":
			return ev.Source, 0, true
		case "compact":
			return "compact", 1, true
		}
	case contract.PostCompact:
		return "compact", 2, true
	case contract.SubagentStart:
		if ev.AgentID != "" {
			return "subagent", 0, true
		}
	}
	return "", 0, false
}

// momentKind reports whether an event can carry a moment. Claude Code sends
// PostToolUse per call and PostToolBatch once per batch of parallel calls:
// moments go out once per batch, so its PostToolUse delivers nothing (it
// stays for output trimming). Failures arrive on their own event everywhere.
func momentKind(ev contract.Event) bool {
	switch ev.Kind {
	case contract.PostToolBatch, contract.PostToolFailure:
		return true
	case contract.PostTool:
		return ev.Agent != "claude-code"
	case contract.Prompt:
		return ev.Prompt != nil && ev.Prompt.Typed && strings.TrimSpace(ev.Prompt.Text) != ""
	}
	return false
}

type group struct {
	project, checkout string
	snap              *entries.Snapshot
	cands             []candidate
	firstRel          string
	edits             []string // files edited in this call that some entry covers
}

// Handle must be called after checkout, consent and pause resolution. Events
// with no moment return before any file read or SQLite open; events whose
// moments find no candidate return before SQLite.
func Handle(ev contract.Event, env Environment) (contract.Reply, error) {
	reason, signal, isLifecycle := lifecycle(ev)
	isMoment := momentKind(ev)
	if !isLifecycle && !isMoment {
		return contract.Reply{}, nil
	}
	if ev.SessionID == "" || env.RecordDirectory == "" {
		return contract.Reply{}, nil
	}
	if env.Now.IsZero() {
		env.Now = time.Now()
	}
	if isLifecycle && (ev.ProjectID == "" || ev.Checkout == "") {
		isLifecycle = false
	}
	var groups []*group
	if isMoment {
		groups = collect(ev, env)
	}
	if !isLifecycle && len(groups) == 0 {
		return contract.Reply{}, nil
	}

	for _, name := range []string{"hooks.db", "hooks.db-wal", "hooks.db-shm"} {
		if !safefile.Regular(filepath.Join(env.RecordDirectory, name)) {
			return contract.Reply{}, errors.New("redirected hooks database")
		}
	}
	h, err := record.OpenHooks(record.Location{Directory: env.RecordDirectory, Hooks: filepath.Join(env.RecordDirectory, "hooks.db")})
	if err != nil {
		return contract.Reply{}, err
	}
	defer h.Close()

	var blocks []string
	if isLifecycle {
		req := baseRequest(ev, env, ev.ProjectID, ev.Checkout)
		req.Reason, req.CompactSignal = reason, signal
		req.Budget = EpochBudget(ev.Model, ev.AgentID != "")
		if ev.Model == "" && ev.AgentID == "" {
			req.Budget = 0 // keep the known window across signals without model metadata
		}
		res, err := h.CheckAndMark(req)
		if err != nil {
			return contract.Reply{}, err
		}
		text, err := lifecycleBlock(h, ev, env, reason, signal, res.Epoch)
		if err != nil {
			return contract.Reply{}, err
		}
		if text != "" {
			blocks = append(blocks, text)
		}
	}

	for _, g := range groups {
		if len(g.edits) > 0 {
			if err := h.NoteEdits(record.Session{SessionID: ev.SessionID, Agent: ev.Agent, ProjectID: g.project, Checkout: g.checkout}, ev.AgentID, g.edits); err != nil {
				return contract.Reply{}, err
			}
		}
		if len(g.cands) == 0 {
			continue
		}
		text, err := deliver(h, ev, env, g)
		if err != nil {
			return contract.Reply{}, err
		}
		if text != "" {
			blocks = append(blocks, text)
		}
	}
	return contract.Reply{Context: strings.Join(blocks, "\n\n")}, nil
}

func baseRequest(ev contract.Event, env Environment, project, checkout string) record.DeliveryRequest {
	return record.DeliveryRequest{
		Session:     record.Session{SessionID: ev.SessionID, Agent: ev.Agent, ProjectID: project, Checkout: checkout},
		AgentID:     ev.AgentID,
		Now:         env.Now,
		KeepSession: env.KeepSession,
	}
}

// collect finds candidates per checkout without touching SQLite. Snapshots
// load once per checkout per call.
func collect(ev contract.Event, env Environment) []*group {
	byCheckout := map[string]*group{}
	var order []*group
	get := func(project, checkout string) *group {
		if project == "" || checkout == "" {
			return nil
		}
		key := project + "\n" + checkout
		if g, ok := byCheckout[key]; ok {
			return g
		}
		g := &group{project: project, checkout: checkout}
		if snap, err := entries.LoadLight(env.RecordDirectory, env.Home, project, checkout); err == nil && len(snap.Items) > 0 {
			g.snap = &snap
		}
		byCheckout[key] = g
		order = append(order, g)
		return g
	}
	if ev.Kind == contract.Prompt {
		if g := get(ev.ProjectID, ev.Checkout); g != nil && g.snap != nil {
			g.cands = promptMoments(ev.Prompt.Text, g.snap)
		}
	} else {
		hintGates := map[string]func(*entries.Item) bool{}
		for _, v := range views(ev, env.Resolve) {
			g := get(v.project, v.checkout)
			if g == nil || g.snap == nil {
				continue
			}
			gate := hintGates[g.project]
			if gate == nil {
				gate = hintGate(env.RecordDirectory, g.project, ev.Agent, env.Now)
				hintGates[g.project] = gate
			}
			found := moments(v, g.snap, gate)
			if len(found) > 0 && g.firstRel == "" {
				g.firstRel = v.rel
			}
			g.cands = append(g.cands, found...)
			if isEdit(v) && covered(g.snap, v.rel) {
				g.edits = append(g.edits, v.rel)
			}
		}
	}
	var out []*group
	for _, g := range order {
		if len(g.cands) > 0 || len(g.edits) > 0 {
			out = append(out, g)
		}
	}
	return out
}

func isEdit(v toolView) bool {
	return v.rel != "" && (v.name == contract.ToolEdit || v.name == contract.ToolWrite || v.name == contract.ToolPatch) && (v.output == nil || v.output.OK)
}

// covered reports whether any entry's scope covers a path: only such edits
// matter to the recovery block, so only they are written down.
func covered(snap *entries.Snapshot, rel string) bool {
	for i := range snap.Items {
		if inScope(&snap.Items[i], rel) {
			return true
		}
	}
	return false
}

// deliver runs the hard gates that need storage, the verdict table, packing
// and the ledger for one checkout, and renders what the ledger gave.
func deliver(h *record.Hooks, ev contract.Event, env Environment, g *group) (string, error) {
	verdicts := map[string]string{}
	verdictOf := func(id string) string {
		if v, ok := verdicts[id]; ok {
			return v
		}
		v, ok, err := h.VerdictOf(g.project, g.checkout, id)
		out := unknown
		if err == nil && ok {
			out = v.Verdict
		}
		verdicts[id] = out
		return out
	}
	// Dedupe before the cut: what this epoch already has never takes a slot,
	// and a repeat moment never loads text. Broken entries stay so they can
	// bring their correction.
	present, err := h.Presence(ev.SessionID, ev.AgentID, g.project, g.checkout)
	if err != nil {
		return "", err
	}
	fresh := g.cands[:0:0]
	var onBranch blockState
	for _, c := range g.cands {
		id := c.item.Entry.ID
		carried := present[id]
		if len(carried) == 0 || verdictOf(id) == broken {
			fresh = append(fresh, c)
			continue
		}
		// Claude Code: a rewind can drop the block that carried it.
		if ev.Agent == "claude-code" && ev.Transcript != "" {
			if onBranch == nil {
				onBranch = transcriptBlocks(env.RecordDirectory, ev.Transcript)
			}
			gone := true
			for _, b := range carried {
				if active, known := onBranch(b); !known || active {
					gone = false
					break
				}
			}
			if gone {
				c.resend = true
				fresh = append(fresh, c)
			}
		}
	}
	g.cands = fresh
	if len(g.cands) == 0 {
		return "", nil
	}
	if g.snap.Light {
		// A light snapshot found the moment; the text comes from the full one.
		full, err := entries.Load(env.RecordDirectory, env.Home, g.project, g.checkout)
		if err != nil {
			return "", err
		}
		byID := map[string]*entries.Item{}
		for i := range full.Items {
			byID[full.Items[i].Entry.ID] = &full.Items[i]
		}
		var kept []candidate
		for _, c := range g.cands {
			if it := byID[c.item.Entry.ID]; it != nil && it.Hash == c.item.Hash {
				c.item = it
				kept = append(kept, c)
			}
		}
		g.snap, g.cands = &full, kept
		if len(kept) == 0 {
			return "", nil
		}
	}
	cov := loadCoverage(ev.Agent, g.checkout, g.firstRel, brief.Options{Checkout: g.checkout, MexHome: env.Home, ProjectID: g.project, Agent: ev.Agent, RecordDirectory: env.RecordDirectory, SessionID: ev.SessionID, AgentID: ev.AgentID, NativeCwd: ev.Cwd})
	senv := &shapeEnv{recordDirectory: env.RecordDirectory, project: g.project, checkout: g.checkout}
	defer senv.close()
	// Strongest moment per entry, then the verdict decides the form.
	best := map[string]candidate{}
	var ids []string
	for _, c := range g.cands {
		id := c.item.Entry.ID
		if cov.covers(c.item) {
			continue
		}
		old, ok := best[id]
		if !ok {
			ids = append(ids, id)
		}
		if !ok || c.tier < old.tier || (c.reserve && !old.reserve) {
			best[id] = c
		}
	}
	if len(ids) == 0 {
		return "", nil
	}
	var items []shaped
	var corrections []planned
	for _, id := range ids {
		s := shape(best[id], verdictOf(id), senv)
		items = append(items, s)
		if s.action == "withheld" && s.verdict == broken {
			// Sent only if this entry was given earlier in the epoch; the
			// ledger decides under its lock.
			corrections = append(corrections, planned{shaped: s, form: "one-line", tokens: 20, correction: true})
		}
	}
	byID := map[string]*entries.Item{}
	for i := range g.snap.Items {
		byID[g.snap.Items[i].Entry.ID] = &g.snap.Items[i]
	}
	companion := func(id string) *shaped {
		it := byID[id]
		if it == nil || cov.covers(it) {
			return nil
		}
		s := shape(candidate{item: it, moment: "companion", tier: tierFolder}, verdictOf(id), senv)
		return &s
	}
	plan := append(corrections, pack(items, companion)...)
	req := baseRequest(ev, env, g.project, g.checkout)
	req.Candidates = requestCandidates(plan)
	req.Admit = admit(plan)
	res, err := h.CheckAndMark(req)
	if err != nil {
		return "", err
	}
	if len(res.Receipts) == 0 {
		return "", nil
	}
	return render(res.Receipts[0].BlockID, plan, res.Receipts), nil
}
