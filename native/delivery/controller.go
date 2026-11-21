// Package delivery owns context admission: one controller per context epoch
// decides what the agent gets and when. It is silent by default; a note goes
// out only when its moment comes, every hard gate passes and its verdict
// allows it, and the ledger records it in the same transaction that admits it.
package delivery

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/brief"
	"github.com/mex-memory/mex/native/capture"
	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/delivery/rank"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/internal/gitstate"
	"github.com/mex-memory/mex/native/internal/safefile"
	"github.com/mex-memory/mex/native/record"
)

type Environment struct {
	BudgetPercent         int // explicit offline replay only; ordinary hooks leave zero
	fileIndexes           *fileIndexCache
	policy                *policyCache
	Home, RecordDirectory string
	Now                   time.Time
	Scorer                string // environment override, resolved without I/O
	Surfaces              string // all-surface state or JSON map, test override
	Offline               bool
	CaptureDisabled       bool
	Notices               bool // adapter supports person-facing output on this event
	// NoContext: the agent's profile has no channel to the model for this
	// event, so moments must not be sent or recorded as given.
	NoContext   bool
	Aids        string // MEX_DELIVERY_ALIASES override: on or off, no I/O
	Trace       func(string, time.Duration)
	KeepSession func(agent, sessionID string) bool
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

func replayBudget(ev contract.Event, env Environment) int {
	budget := EpochBudget(ev.Model, ev.AgentID != "")
	if env.BudgetPercent > 0 && env.BudgetPercent <= 100 {
		budget = budget * env.BudgetPercent / 100
	}
	return budget
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
		return ev.Prompt != nil && ev.Prompt.Typed && strings.TrimSpace(ev.Prompt.Text) != "" && !rank.Machine(ev.Prompt.Text)
	}
	return false
}

type group struct {
	project, checkout string
	snap              *entries.Snapshot
	cands             []candidate
	firstRel          string
	ranked            []rank.Result
	text              string     // bounded prompt text
	views             []toolView // references only; scoring text is assembled after hard gates
	edits             []string   // files edited in this call that some entry covers
	cards             []answerCard
	cardsConsumed     bool
	reservedUsed      int             // correction tokens already sent in this moment
	deliberate        map[string]bool // rules the agent went past a speed bump for this epoch
	shellEdits        []string        // files a shell command changed against a strong rule or in a procedure's area
}

// maxPromptPointers bounds what a prompt brings: pointers, never full text,
// because text injected mid-session is paid again on every later turn.
const maxPromptPointers = 2

// Handle must be called after checkout, consent and pause resolution. Events
// with no moment, lifecycle or correction work return before SQLite. A bounded
// advisory hint and an existing ledger allow follow-ups without a new candidate.
// With no candidate, covered edit, pending observation, rescue, history notice
// or lifecycle work, the event returns before SQLite.
func Handle(ev contract.Event, env Environment) (contract.Reply, error) {
	if ev.Prompt != nil {
		prompt := *ev.Prompt
		prompt.Text = rank.PromptText(prompt.Text)
		ev.Prompt = &prompt
	}
	reason, signal, isLifecycle := lifecycle(ev)
	isMoment := momentKind(ev)
	lateRecovery := ev.Kind == contract.Prompt && ev.Agent == "claude-code" && ev.ProjectID != "" &&
		env.RecordDirectory != "" && capture.CompactionPending(ev, env.RecordDirectory)
	isEnd := ev.Kind == contract.SessionEnd
	isSearch := searchEvent(ev)
	var adviceIDs []string
	if isMoment || ev.Kind == contract.SessionStart || ev.Kind == contract.SubagentStart || (ev.Kind == contract.Stop && ev.Agent == "claude-code") {
		adviceIDs = record.AdviceIDs(env.RecordDirectory, ev.Checkout)
	}
	if isEnd {
		if _, err := os.Stat(filepath.Join(env.RecordDirectory, "hooks.db")); err != nil {
			return contract.Reply{}, nil
		}
	}
	if !isLifecycle && !isMoment && !isSearch && !isEnd && !lateRecovery && len(adviceIDs) == 0 {
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
	var indexes fileIndexCache
	env.fileIndexes = &indexes
	defer indexes.close()
	var policies policyCache
	env.policy = &policies
	var groups []*group
	var anchors []Anchor
	cards := searchCards(ev, env)
	if isMoment {
		if ev.Kind == contract.Prompt && surfaceSetting(env, ev.ProjectID, "prompt-anchor") != "off" {
			anchors = VerifyAnchors(ev, env)
			cards = anchorCard(anchors)
		}
		var vocabulary []answerCard
		var vocabularyOut *[]answerCard
		if ev.Kind == contract.Prompt && surfaceSetting(env, ev.ProjectID, "prompt-vocabulary") != "off" {
			vocabularyOut = &vocabulary
		}
		groups = collect(ev, env, anchors, vocabularyOut)
		if ev.Kind == contract.Prompt {
			var kept []*group
			for _, g := range groups {
				var prose []candidate
				for _, c := range g.cands {
					if c.moment == "prompt-arm" {
						arm := c
						cards = append(cards, answerCard{surface: "prompt-anchor", id: c.item.Entry.ID, arm: &arm})
					} else {
						prose = append(prose, c)
					}
				}
				g.cands = prose
				if len(g.cands) > 0 {
					kept = append(kept, g)
				}
			}
			groups = kept
			cards = append(cards, vocabulary...)
		}
	}
	pending := isMoment && ev.Kind != contract.Prompt && record.SurfacePending(env.RecordDirectory, ev.SessionID, ev.AgentID)
	var stuck *rescue
	var history []historyNotice
	if isMoment && ev.Kind != contract.Prompt {
		stuck = findRescue(ev, env)
		history = findHistory(ev, env)
	}
	// The agent's profile says text on this event can't reach the model
	// (Cursor's and Copilot's prompt hooks, Antigravity's and Kiro's tool
	// results). Nothing is sent, so nothing is recorded as given, and each
	// entry stays due for a moment the agent can receive. Edits are still
	// noted, and a prompt still arms entries for the first read of the files
	// it names: an armed entry is held back now, not given.
	if env.NoContext && !isLifecycle {
		stuck, history = nil, nil
		var armed []answerCard
		for _, c := range cards {
			if c.arm != nil {
				armed = append(armed, c)
			}
		}
		cards = armed
		for _, g := range groups {
			g.cands = nil
		}
	}
	if !isLifecycle && !isEnd && !lateRecovery && len(groups) == 0 && len(cards) == 0 && len(adviceIDs) == 0 && !pending && stuck == nil && len(history) == 0 {
		return contract.Reply{}, nil
	}
	// A call that delivers nothing only adds evidence to open acted windows:
	// log it and leave SQLite closed. The next transaction settles the log.
	if pending && !isLifecycle && !isEnd && len(groups) == 0 && len(cards) == 0 && len(adviceIDs) == 0 && stuck == nil && len(history) == 0 && !env.Offline {
		if err := record.AppendSurfaceObservations(env.RecordDirectory, ev.SessionID, ev.AgentID, surfaceTools(ev, env)); err == nil {
			return contract.Reply{}, nil
		}
	}
	// Any transaction settles logged calls first, in order, before this
	// event's own, so lifecycle changes and deliveries see them.
	hintDir := (isMoment && ev.Kind != contract.Prompt) || isLifecycle || isEnd
	var logged []record.SurfaceTool
	restoreLog := func() {}
	if hintDir && record.SurfacePending(env.RecordDirectory, ev.SessionID, ev.AgentID) {
		logged, restoreLog = record.TakeSurfaceObservations(env.RecordDirectory, ev.SessionID, ev.AgentID)
	}

	for _, name := range []string{"hooks.db", "hooks.db-wal", "hooks.db-shm"} {
		if !safefile.Regular(filepath.Join(env.RecordDirectory, name)) {
			restoreLog()
			return contract.Reply{}, errors.New("redirected hooks database")
		}
	}
	finish := phase(env.Trace, "record-open")
	h, err := record.OpenHooks(record.Location{Directory: env.RecordDirectory, Hooks: filepath.Join(env.RecordDirectory, "hooks.db")})
	finish()
	if err != nil {
		restoreLog()
		return contract.Reply{}, fmt.Errorf("record-open: %w", err)
	}
	h.Trace = env.Trace
	defer h.Close()
	var notices []string
	if pending || len(logged) > 0 {
		req := baseRequest(ev, env, ev.ProjectID, ev.Checkout)
		req.SurfaceTools = logged
		if pending {
			req.SurfaceTools = append(req.SurfaceTools, surfaceTools(ev, env)...)
		}
		req.Notify = env.Notices
		res, observeErr := h.CheckAndMark(req)
		if observeErr != nil {
			restoreLog()
			err = observeErr
			return contract.Reply{}, err
		}
		notices = append(notices, res.Notices...)
	}

	var blocks []string
	if isLifecycle || isEnd {
		req := baseRequest(ev, env, ev.ProjectID, ev.Checkout)
		req.Reason, req.CompactSignal = reason, signal
		req.EndEpoch = isEnd
		req.Notify = env.Notices
		req.Budget = replayBudget(ev, env)
		if ev.Model == "" && ev.AgentID == "" && env.BudgetPercent == 0 {
			req.Budget = 0 // keep the known window across signals without model metadata
		}
		res, err := h.CheckAndMark(req)
		if err != nil {
			return contract.Reply{}, err
		}
		notices = append(notices, res.Notices...)
		if isEnd {
			return contract.Reply{PersonLine: strings.Join(res.Notices, " ")}, nil
		}
		if ev.Agent == "claude-code" && ev.Kind == contract.PostCompact {
			checkCompaction(h, ev, env, res.Epoch.Number)
		}
		text, err := lifecycleBlock(h, ev, env, reason, signal, res.Epoch)
		if err != nil {
			return contract.Reply{}, err
		}
		if text != "" {
			blocks = append(blocks, text)
		}
		// A new session, not a resume, a fork or a compaction.
		if reason == "startup" || reason == "clear" {
			blocks = append(blocks, carryBlocks(h, ev, env)...)
		}
	}
	if lateRecovery {
		if epoch, ok, err := h.CurrentEpoch(ev.SessionID, ev.AgentID); err == nil && ok {
			if text := checkedRecovery(h, ev, env, epoch.Number); text != "" {
				blocks = append(blocks, text)
			}
		}
	}

	adviceHandled := false
	for _, g := range groups {
		if g.snap == nil {
			if err := noteCompactionEdits(h, ev, g); err != nil {
				return contract.Reply{}, err
			}
			continue
		}
		if ev.Kind == contract.Prompt && g.project == ev.ProjectID && g.checkout == ev.Checkout {
			g.cards = cards
		}
		finish := phase(env.Trace, "record-observations")
		obs, err := holdbackObservations(h, ev, g)
		if err != nil {
			return contract.Reply{}, fmt.Errorf("record-holdbacks: %w", err)
		}
		previous, err := h.Intent(ev.SessionID, ev.AgentID)
		if err != nil {
			return contract.Reply{}, fmt.Errorf("record-intent: %w", err)
		}
		probes, touches, err := deliveredObservations(h, ev, g)
		if err != nil {
			return contract.Reply{}, fmt.Errorf("record-probes: %w", err)
		}
		commands, failed := commandObservations(g)
		if hasEdit(g.views) {
			if e, _, err := h.CurrentEpoch(ev.SessionID, ev.AgentID); err == nil {
				g.deliberate = Deliberate(env.RecordDirectory, ev, e.Number)
			}
		}
		if len(commands) > 0 || len(obs) > 0 || len(probes) > 0 || len(touches) > 0 || observeIntent(previous, ev, g) != previous {
			req := baseRequest(ev, env, g.project, g.checkout)
			req.Observations = obs
			req.Probes, req.Touches = probes, touches
			req.Intent = observeIntent(previous, ev, g)
			req.Commands, req.FailedCommand = commands, failed
			if _, err = h.CheckAndMark(req); err != nil {
				return contract.Reply{}, err
			}
		}
		if err := noteCompactionEdits(h, ev, g); err != nil {
			return contract.Reply{}, err
		}
		if err := releaseHeldRules(h, ev, g); err != nil {
			return contract.Reply{}, fmt.Errorf("record-holdbacks: %w", err)
		}
		finish()
		if len(adviceIDs) > 0 && !adviceHandled && g.checkout == ev.Checkout {
			adviceHandled = true
			block, err := adviceBlock(h, ev, env, adviceIDs)
			if err != nil {
				return contract.Reply{}, err
			}
			g.reservedUsed = block.tokens
			if block.text != "" {
				blocks = append(blocks, block.text)
			}
		}
		if len(g.cands) == 0 {
			continue
		}
		text, err := deliver(h, ev, env, g)
		if g.cardsConsumed {
			cards = nil
		}
		if err != nil {
			return contract.Reply{}, err
		}
		if text != "" {
			blocks = append(blocks, text)
		}
	}
	if text, err := deliverCards(h, ev, env, cards); err != nil {
		return contract.Reply{}, err
	} else if text != "" {
		blocks = append(blocks, text)
	}
	if len(adviceIDs) > 0 && !adviceHandled {
		block, err := adviceBlock(h, ev, env, adviceIDs)
		if err != nil {
			return contract.Reply{}, err
		}
		if block.text != "" {
			blocks = append(blocks, block.text)
		}
	}
	if stuck != nil {
		text, err := deliverRescue(h, ev, env, stuck)
		if err != nil {
			return contract.Reply{}, err
		}
		if text != "" {
			blocks = append(blocks, text)
		}
	}
	if len(history) > 0 {
		text, err := deliverHistory(h, ev, env, history)
		if err != nil {
			return contract.Reply{}, err
		}
		if text != "" {
			blocks = append(blocks, text)
		}
	}
	return contract.Reply{Context: strings.Join(blocks, "\n\n"), PersonLine: strings.Join(notices, " ")}, nil
}

func noteCompactionEdits(h *record.Hooks, ev contract.Event, g *group) error {
	if len(g.edits) == 0 {
		return nil
	}
	session := record.Session{SessionID: ev.SessionID, Agent: ev.Agent, ProjectID: g.project, Checkout: g.checkout}
	return h.NoteEdits(session, ev.AgentID, g.edits)
}

func baseRequest(ev contract.Event, env Environment, project, checkout string) record.DeliveryRequest {
	at, _ := gitstate.Read(checkout)
	return record.DeliveryRequest{
		Lanes:   true,
		Session: record.Session{SessionID: ev.SessionID, Agent: ev.Agent, ProjectID: project, Checkout: checkout},
		AgentID: ev.AgentID,
		Branch:  at.Branch, Head: at.Head,
		Now:         env.Now,
		KeepSession: env.KeepSession,
		SurfaceMode: func(surface string) string { return surfaceSetting(env, project, surface) },
		Offline:     env.Offline,
	}
}

// collect finds candidates per checkout without touching SQLite. Snapshots
// load once per checkout per call.
func collect(ev contract.Event, env Environment, anchors []Anchor, vocabulary *[]answerCard) []*group {
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
		finish := phase(env.Trace, "snapshot-load")
		if snap, err := entries.LoadLight(env.RecordDirectory, env.Home, project, checkout); err == nil && len(snap.Items) > 0 {
			g.snap = &snap
		}
		finish()
		byCheckout[key] = g
		order = append(order, g)
		return g
	}
	if ev.Kind == contract.Prompt {
		if g := get(ev.ProjectID, ev.Checkout); g != nil && g.snap != nil {
			finish := phase(env.Trace, "prompt-index")
			ix, snapshot, err := entries.PromptIndex(env.RecordDirectory, env.Home, g.project, g.checkout, *g.snap, aidsSetting(env))
			finish()
			if err == nil {
				g.snap = &snapshot
				g.cands = promptMoments(ev.Prompt.Text, g.snap)
				byID := map[string]*entries.Item{}
				gate := hintGate(env.RecordDirectory, g.project, ev.Agent, env.Now)
				for i := range g.snap.Items {
					it := &g.snap.Items[i]
					if it.NeedsHintGate && !gate(it) {
						continue
					}
					byID[it.Entry.ID] = it
				}
				finish = phase(env.Trace, "prompt-rank")
				g.ranked = ix.Rank(boundedText(ev.Prompt.Text, 65536))
				finish()
				possible := false
				for i := range g.ranked {
					if len(rank.Select(g.ranked[i:], rank.DefaultGate())) > 0 {
						possible = true
						break
					}
				}
				if possible {
					for _, r := range g.ranked {
						if it := byID[r.ID]; it != nil {
							g.cands = append(g.cands, candidate{item: it, moment: momentPrompt, tier: tierPrompt, pointer: true})
						}
					}
				}
			}
			g.text = boundedText(ev.Prompt.Text, 64*1024)
			g.cands = append(g.cands, armAnchors(anchors, g.snap)...)
			if vocabulary != nil {
				*vocabulary = vocabularyCards(ev, env, g.snap, hintGate(env.RecordDirectory, g.project, ev.Agent, env.Now))
			}
		}
	} else {
		hintGates := map[string]func(*entries.Item) bool{}
		for _, v := range views(ev, env.Resolve) {
			g := get(v.project, v.checkout)
			if g == nil {
				continue
			}
			if isEdit(v) && ((ev.Agent == "claude-code" && ev.Kind == contract.PostToolBatch &&
				v.output != nil && v.output.OK) || (g.snap != nil && covered(g.snap, v.rel))) {
				g.edits = append(g.edits, v.rel)
			}
			if g.snap == nil {
				continue
			}
			gate := hintGates[g.project]
			if gate == nil {
				gate = hintGate(env.RecordDirectory, g.project, ev.Agent, env.Now)
				hintGates[g.project] = gate
			}
			g.views = append(g.views, v)
			found := moments(v, g.snap, gate)
			if len(found) > 0 && g.firstRel == "" {
				g.firstRel = v.rel
			}
			g.cands = append(g.cands, found...)
			if caught := shellCaught(v, env, g.snap); len(caught) > 0 {
				g.cands = append(g.cands, caught...)
				for _, c := range caught {
					g.shellEdits = append(g.shellEdits, c.rel)
				}
			}
			if procs := shellProcedures(v, env, g.snap); len(procs) > 0 {
				g.cands = append(g.cands, procs...)
				for _, c := range procs {
					g.shellEdits = append(g.shellEdits, c.rel)
				}
			}
		}
	}
	for _, g := range order {
		monitorGroup(env, g)
	}
	var out []*group
	_, ledgerErr := os.Stat(filepath.Join(env.RecordDirectory, "hooks.db"))
	for _, g := range order {
		if len(g.cands) > 0 {
			kept := g.cands[:0]
			for _, c := range g.cands {
				if surfaceSetting(env, g.project, record.SurfaceForMoment(c.moment)) != "off" {
					kept = append(kept, c)
				}
			}
			g.cands = kept
		}
		if len(g.cands) > 0 || len(g.edits) > 0 || (ledgerErr == nil && g.snap != nil && len(g.views) > 0 && (hasAdviceEffects(g.views) || anchorRead(g.views, ev, env))) {
			out = append(out, g)
		}
	}
	return out
}

func hasEdit(vs []toolView) bool {
	for _, v := range vs {
		if isEdit(v) {
			return true
		}
	}
	return false
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
		return "", fmt.Errorf("record-presence: %w", err)
	}
	corrected := map[string]bool{}
	if len(present) > 0 {
		epoch, found, err := h.CurrentEpoch(ev.SessionID, ev.AgentID)
		if err != nil {
			return "", err
		}
		if found {
			corrected, err = h.CorrectedAdvice(ev.SessionID, ev.AgentID, g.project, g.checkout, epoch.Number)
			if err != nil {
				return "", err
			}
		}
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
				continue
			}
		}
		c.control = true
		fresh = append(fresh, c)
	}
	g.cands = fresh
	if len(g.cands) == 0 {
		return "", nil
	}
	cov := loadCoverage(ev.Agent, g.checkout, g.firstRel, brief.Options{Checkout: g.checkout, MexHome: env.Home, ProjectID: g.project, Agent: ev.Agent, RecordDirectory: env.RecordDirectory, SessionID: ev.SessionID, AgentID: ev.AgentID, NativeCwd: ev.Cwd})
	senv := &shapeEnv{recordDirectory: env.RecordDirectory, project: g.project, checkout: g.checkout, hooks: h}
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
	// Rank unseen, natively uncovered items. IDF is over the gated snapshot;
	// an item already carried never consumes the gate's two available slots.
	if ev.Kind == contract.Prompt {
		ranked := g.ranked
		filtered := make([]rank.Result, 0, len(ranked))
		for _, r := range ranked {
			if _, ok := best[r.ID]; ok {
				filtered = append(filtered, r)
			}
		}
		allowed := map[string]bool{}
		for _, r := range rank.Select(filtered, rank.DefaultGate()) {
			allowed[r.ID] = true
		}
		var kept []string
		for _, id := range ids {
			c := best[id]
			// Word overlap filters; only an exact anchor sends.
			if c.tier != tierPrompt || (allowed[id] && promptAnchored(c.item, g.text)) {
				kept = append(kept, id)
			}
		}
		// At most two pointers per prompt, the most exact first.
		sort.SliceStable(kept, func(i, j int) bool { return best[kept[i]].tier < best[kept[j]].tier })
		if len(kept) > maxPromptPointers {
			kept = kept[:maxPromptPointers]
		}
		ids = kept
		if len(ids) == 0 {
			return "", nil
		}
	}
	if g.snap.Light {
		finish := phase(env.Trace, "selected-load")
		wanted := map[string]bool{}
		for _, id := range ids {
			wanted[id] = true
		}
		for id := range present {
			if len(wanted) >= 1000 {
				return "", errors.New("prompt presence bound")
			}
			wanted[id] = true
		}
		full, err := entries.Selected(env.Home, g.project, g.checkout, *g.snap, wanted)
		finish()
		if err != nil {
			return "", err
		}
		byID := map[string]*entries.Item{}
		for i := range full.Items {
			byID[full.Items[i].Entry.ID] = &full.Items[i]
		}
		var kept []string
		for _, id := range ids {
			if it := byID[id]; it != nil {
				c := best[id]
				c.item = it
				best[id] = c
				kept = append(kept, id)
			}
		}
		ids = kept
		g.snap = &full
	}
	intent, err := h.Intent(ev.SessionID, ev.AgentID)
	if err != nil {
		return "", err
	}
	var items []shaped
	var corrections []planned
	correctionTokens := 0
	for _, id := range ids {
		s := shape(best[id], verdictOf(id), senv)
		if s.pointer && s.action == "given" && s.oneLine != "" {
			s.full, s.fullTok = s.oneLine, s.lineTok
		}
		if s.action == "given" && s.moment == "prompt-arm" {
			s.action, s.detail = "held-back", "prompt-anchor"
		}
		if s.action == "given" && s.item.Entry.Kind == "rule" && intent == "investigating" && !s.anchorRelease {
			s.action, s.detail = "held-back", "investigating"
		}
		if s.action == "given" && s.item.Entry.Kind == "rule" && intent == "changing" {
			for _, v := range g.views {
				if isEdit(v) && inScope(s.item, v.rel) && g.snap.Patterns().InEdit(v.removed, s.item, "anti") && !g.snap.Patterns().InEdit(v.added, s.item, "anti") {
					s.full = "Current convention: " + s.oneLine
					s.oneLine = s.full
					s.fullTok = entries.EstimateTokens(s.full)
					s.lineTok = s.fullTok
					break
				}
			}
		}
		items = append(items, s)
		if s.action == "withheld" && s.verdict == broken && len(present[id]) > 0 && !corrected[id] {
			// Sent only if this entry was given earlier in the epoch; the
			// ledger decides under its lock.
			text, err := currentCorrection(h, ev, g, id)
			if err != nil {
				return "", err
			}
			cost := entries.EstimateTokens(text) + 8
			if correctionTokens+cost <= reservedLane-g.reservedUsed {
				corrections = append(corrections, planned{shaped: s, text: text, form: "one-line", tokens: cost, correction: true})
				correctionTokens += cost
			}
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
	name := scorerSetting(env, g.project)
	var missed map[string]int
	needsMisses := false
	for _, s := range items {
		if len(triggers(s.item, "anti")) > 0 {
			needsMisses = true
			break
		}
	}
	if name == "risk" && needsMisses {
		var err error
		missed, err = h.MissedCounts(g.project, g.checkout)
		if err != nil {
			return "", err
		}
	}
	query := g.text
	if name == "bm25" || name == "risk" {
		if name == "risk" {
			query = ""
		}
		for _, v := range g.views {
			if name == "risk" && (v.name != contract.ToolRead || v.output == nil) {
				continue
			}
			if len(query) >= 65536 {
				break
			}
			text := viewText(v)
			if name == "risk" {
				text = boundedText(v.output.Text, 65536)
			}
			query += boundedText(" "+text, 65536-len(query))
		}
	}
	var scorer Scorer
	if name == "bm25" && ev.Kind == contract.Prompt {
		// The prompt ranker already scored these entries with field-weighted
		// BM25 over persisted statistics; reuse it instead of loading every
		// entry's text to rebuild a plain index.
		scores := make(map[string]float64, len(g.ranked))
		for _, r := range g.ranked {
			scores[r.ID] = r.Score
		}
		scorer = bm25Scorer{scores}
	} else {
		scorer = newScorer(name, query, g.snap, items, missed)
	}
	items, conflicts := resolveConflicts(items)
	var known []record.GivenRow
	if len(present) > 0 {
		known, _, err = h.EpochSelected(ev.SessionID, ev.AgentID, g.project, g.checkout, -1, true)
		if err != nil {
			return "", err
		}
	}
	validPrior := func(row record.GivenRow) *entries.Item {
		it := byID[row.EntryID]
		if it == nil {
			return nil
		}
		if row.ContentHash != contentHash(it.Hash+"\n"+it.Full) && row.ContentHash != contentHash(it.Hash+"\n"+it.OneLine) {
			return nil
		}
		return it
	}
	for i := range items {
		if items[i].action == "given" && !items[i].resend {
			duplicate := nativeSimilar(entryClaim(items[i].item.Entry), cov.texts)
			for _, row := range known {
				if it := validPrior(row); it != nil && itemSimilar(items[i].item, it) {
					duplicate = true
					break
				}
			}
			if duplicate {
				items[i].action, items[i].detail = "withheld", "similar"
			}
		}
	}
	budget := replayBudget(ev, env)
	if epoch, ok, err := h.CurrentEpoch(ev.SessionID, ev.AgentID); err == nil && ok {
		budget = epoch.Budget
	}
	plan := append(corrections, packInto(items, companion, reservedLane-g.reservedUsed-correctionTokens, scorer, budget)...)
	req := baseRequest(ev, env, g.project, g.checkout)
	req.Candidates = requestCandidates(plan)
	surfaceTargets(plan, g.views, req.Candidates)
	for i, p := range plan {
		if p.control {
			req.Candidates[i].Action = "control"
		}
	}
	req.Conflicts = conflicts
	comparisons := 0
	req.Similar = func(c record.DeliveryCandidate, rows []record.GivenRow) string {
		it := byID[c.EntryID]
		if it == nil || c.Resend || c.Action == "replaced" {
			return ""
		}
		for _, row := range rows {
			if row.EntryID == c.EntryID {
				continue
			}
			comparisons++
			if comparisons > 10000 {
				return "similar-bound"
			}
			if prior := validPrior(row); prior != nil && itemSimilar(it, prior) {
				return "similar"
			}
		}
		return ""
	}
	admission := admit(plan, scorer)
	req.Admit = func(epoch record.Epoch, c record.DeliveryCandidate) bool {
		for _, card := range g.cards {
			if card.id == c.EntryID {
				return true
			}
		}
		return admission(epoch, c)
	}
	for _, card := range g.cards {
		req.Candidates = append(req.Candidates, cardCandidate(card))
	}
	res, err := h.CheckAndMark(req)
	if err != nil {
		return "", err
	}
	g.cardsConsumed = true
	if len(res.Receipts) == 0 {
		return "", nil
	}
	text := render(res.Receipts[0].BlockID, plan, res.Receipts)
	lines := cardLines(g.cards, res.Receipts)
	if lines != "" {
		if text == "" {
			text = "[mex " + res.Receipts[0].BlockID + "]"
		}
		text += "\n" + lines
	}
	return text, nil
}

// releaseHeldRules offers again, at an edit, the rules this epoch held back
// while the agent was only investigating: a rule waits for edit risk, and an
// edit inside its scope is that risk. The rule keeps its exact-match exemption.
func releaseHeldRules(h *record.Hooks, ev contract.Event, g *group) error {
	if len(g.edits) == 0 && len(g.views) == 0 {
		return nil
	}
	rows, err := h.HoldbackEntries(ev.SessionID, ev.AgentID, g.project, g.checkout)
	if err != nil {
		return err
	}
	held := map[string]bool{}
	armed := map[string][]string{}
	armedHashes := map[string]string{}
	for _, r := range rows {
		if r.Detail == "prompt-anchor" {
			armedHashes[r.EntryID] = r.ContentHash
			armed[r.EntryID] = append(armed[r.EntryID], r.Paths...)
		}
		if r.Detail == "investigating" {
			held[r.EntryID] = true
		}
	}
	if len(held) == 0 && len(armed) == 0 {
		return nil
	}
	offered := map[string]bool{}
	for _, c := range g.cands {
		offered[c.item.Entry.ID] = true
	}
	for i := range g.snap.Items {
		it := &g.snap.Items[i]
		for _, v := range g.views {
			// A note this call already offers through its own moment (a pitfall at
			// first read) goes out there; the prompt anchor's arming only adds a
			// moment for notes nothing else would send.
			if offered[it.Entry.ID] {
				break
			}
			if (v.name == contract.ToolRead || isEdit(v)) && v.output != nil && v.output.OK && contains(armed[it.Entry.ID], v.rel) && armedHashes[it.Entry.ID] == contentHash(it.Hash+"\n") {
				g.cands = append(g.cands, candidate{item: it, moment: "anchor-touch", tier: tierFile, rel: v.rel, anchorRelease: true, anchorPaths: []string{v.rel}})
				break
			}
		}
		if !held[it.Entry.ID] || offered[it.Entry.ID] || it.Entry.Kind != "rule" {
			continue
		}
		for _, rel := range g.edits {
			if inScope(it, rel) {
				g.cands = append(g.cands, candidate{item: it, moment: momentEdit, tier: tierPattern, exempt: true, rel: rel})
				offered[it.Entry.ID] = true
				break
			}
		}
	}
	return nil
}
