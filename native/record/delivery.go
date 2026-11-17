package record

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// Epoch is the single budget and presence boundary for one agent's context.
type Epoch struct {
	Number                                             int
	Reason                                             string
	Budget, TokensSent, ReservedTokens, CompactSignals int
	SessionTokens                                      int
	Intent                                             string
	LastFailure                                        string
	Closed                                             bool
	ToolCalls                                          int
	CandidateTokens, AdmittedTokens, BudgetHeld        int
	ContentionMeasured                                 bool
}

// DeliveryCandidate is already gated and rendered by the controller. Admit is
// evaluated under the writer lock so parallel calls see the same budget.
type DeliveryCandidate struct {
	Lane                                       string
	Surface                                    string
	Target                                     SurfaceTarget
	Mode                                       string // on, shadow or off; resolved before admission
	EntryID, Moment, Form, Action, ContentHash string
	Detail, Parent                             string
	Title, Kind, Level                         string
	EntryHash, CorrectionFor                   string
	Tokens                                     int
	Reserved, Exempt                           bool
	// Correction marks a short note that an entry given earlier in this
	// epoch no longer holds. It is written once per entry per epoch, only
	// when the entry was given, and always in the reserved lane.
	Correction bool
	// Resend gives an entry again although the ledger has it this epoch: the
	// transcript shows the agent no longer has it (a rewind).
	Resend bool
	// SessionOnce gives an entry at most once per session and agent, and
	// SessionMax caps how many receipts its surface gets in one session.
	// Both count shadow receipts too and are checked under the write lock,
	// so racing hook processes can't exceed them.
	SessionOnce bool
	SessionMax  int
}
type Receipt struct {
	DeliveryCandidate
	ID, BlockID string
}
type DeliveryRequest struct {
	Lanes        bool // controller opts into partitioned admission; older callers retain pooled admission
	Session      Session
	AgentID      string
	Branch, Head string
	// Empty reason keeps the current epoch. Resume likewise never advances it.
	Reason string
	// CompactSignal is 1 for SessionStart and 2 for PostCompact. Different
	// signals confirm a transition; a repeated signal starts the next cycle.
	CompactSignal int
	Budget        int
	Now           time.Time
	Candidates    []DeliveryCandidate
	Observations  []FollowupObservation
	Probes        []FollowupObservation
	Touches       []string
	Intent        string
	Commands      []string // bounded digests of exact commands in this call
	FailedCommand string   // latest failed command digest, if observed
	EndEpoch      bool
	SurfaceTools  []SurfaceTool
	SurfaceMode   func(string) string
	Offline       bool // saved sessions cannot change a gate
	Notify        bool // only when the adapter can show a person-facing line
	Conflicts     []DeliveryConflict
	Similar       func(DeliveryCandidate, []GivenRow) string
	// OnceEntry makes the whole batch conditional on its epoch marker being
	// absent, so a resume cannot send a newly rebuilt start brief.
	OnceEntry string
	Aliases   map[string]string
	Admit     func(Epoch, DeliveryCandidate) bool
	// KeepSession conservatively protects file-heartbeat sessions whose
	// no-op calls deliberately do not open SQLite. Called at most 64 times.
	KeepSession func(agent, sessionID string) bool
}
type DeliveryConflict struct{ Winner, Loser, Reason string }
type DeliveryResult struct {
	Epoch    Epoch
	Receipts []Receipt
	Notices  []string
}

// CheckAndMark commits the lifecycle, aliases, dedupe, admission, receipts and
// counters together. Nothing may be rendered until this returns successfully.
func (hooks *Hooks) CheckAndMark(req DeliveryRequest) (result DeliveryResult, err error) {
	stage := "record-read"
	var started time.Time
	if hooks.Trace != nil {
		started = time.Now()
	}
	next := func(name string) {
		if hooks.Trace != nil {
			hooks.Trace(stage, time.Since(started))
			started = time.Now()
		}
		stage = name
	}
	defer func() {
		if err != nil {
			result = DeliveryResult{}
			err = fmt.Errorf("%s: %w", stage, err)
		}
		next("")
	}()
	if hooks.counterOnly || req.Session.SessionID == "" || req.Session.Agent == "" || req.Session.ProjectID == "" || req.Session.Checkout == "" {
		return result, errors.New("invalid delivery session")
	}
	for _, field := range []string{req.Session.SessionID, req.Session.Agent, req.AgentID, req.Session.ProjectID, req.Session.Checkout} {
		if len(field) > 4096 || strings.ContainsRune(field, 0) {
			return result, errors.New("invalid delivery identity")
		}
	}
	if len(req.SurfaceTools) > 64 || len(req.Commands) > 64 || len(req.Probes) > 1000 || len(req.Touches) > 1000 || len(req.Conflicts) > 1000 || len(req.Observations) > 1000 || len(req.Candidates) > 1000 || len(req.Aliases) > 10000 {
		return result, errors.New("delivery batch exceeds bound")
	}
	for _, tool := range req.SurfaceTools {
		if len(tool.Reads) > 64 || len(tool.Key) > 128 {
			return result, errors.New("surface range bound")
		}
		for _, read := range tool.Reads {
			if len(read.Path) > 4096 || read.Start < 1 || read.End < 0 || read.End > 0 && read.End < read.Start {
				return result, errors.New("surface range bound")
			}
		}
		if len(tool.Paths) > 64 || len(tool.Names) > 64 || len(tool.Command) > 128 || len(tool.Added) > 32768 {
			return result, errors.New("surface observation bound")
		}
		for _, p := range append(append([]string{}, tool.Paths...), tool.Names...) {
			if len(p) > 4096 || strings.ContainsRune(p, 0) {
				return result, errors.New("surface observation field bound")
			}
		}
		if len(tool.Scoped) > 64 {
			return result, errors.New("surface checkout observation bound")
		}
		for key, scoped := range tool.Scoped {
			for _, read := range scoped.Reads {
				if len(read.Path) > 4096 || strings.ContainsRune(read.Path, 0) || read.Start < 1 || read.End < 0 || read.End > 0 && read.End < read.Start {
					return result, errors.New("surface range bound")
				}
			}
			if len(key) > 8192 || strings.ContainsRune(key, 0) || len(scoped.Scoped) > 0 || len(scoped.Reads) > 64 || len(scoped.Key) > 128 || len(scoped.Paths) > 64 || len(scoped.Names) > 64 || len(scoped.Command) > 128 || len(scoped.Added) > 32768 {
				return result, errors.New("surface scoped observation bound")
			}
		}
	}
	if req.Now.IsZero() {
		req.Now = time.Now()
	}
	ctx, cancel := context.WithTimeout(context.Background(), hooks.budget.writer)
	defer cancel()
	conn, err := hooks.db.Conn(ctx)
	if err != nil {
		return result, err
	}
	defer conn.Close()
	// A commit must not also checkpoint the WAL inside the delivery deadline.
	// SQLite still checkpoints on the last connection's close, after this
	// transaction. This connection-local setting changes neither WAL nor sync
	// durability and does not add background work or extend the writer budget.
	if _, err = conn.ExecContext(ctx, "PRAGMA wal_autocheckpoint=0"); err != nil {
		return result, err
	}
	next("record-lock")
	if err = hooks.retryStatement(ctx, conn, "BEGIN IMMEDIATE"); err != nil {
		return result, err
	}
	defer func() { _, _ = conn.ExecContext(context.Background(), "ROLLBACK") }()
	next("record-read")
	// Match existing record timestamps. Retention uses a conservative age
	// boundary; no timestamp is included in model-facing text.
	stamp := req.Now.UTC().Format(time.RFC3339Nano)
	var agent string
	var paused bool
	err = conn.QueryRowContext(ctx, "SELECT agent,paused FROM sessions WHERE session_id=?", req.Session.SessionID).Scan(&agent, &paused)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return result, err
	}
	if err == nil && (agent != req.Session.Agent || paused) {
		return result, errors.New("session unavailable for delivery")
	}
	_, err = conn.ExecContext(ctx, `INSERT INTO sessions(session_id,agent,project_id,checkout,started_at,last_seen_at,paused)
 VALUES(?,?,?,?,?,?,0) ON CONFLICT(session_id) DO UPDATE SET last_seen_at=excluded.last_seen_at
 WHERE sessions.last_seen_at < ?`, req.Session.SessionID, req.Session.Agent, req.Session.ProjectID, req.Session.Checkout, stamp, stamp, req.Now.Add(-30*time.Second).UTC().Format(time.RFC3339Nano))
	if err != nil {
		return result, err
	}
	e := Epoch{}
	err = conn.QueryRowContext(ctx, `SELECT epoch,reason,budget,tokens_sent,reserved_tokens,compact_signals,intent,closed,last_failure,tool_calls,candidate_tokens,admitted_tokens,budget_held,contention_measured FROM epochs
 WHERE session_id=? AND agent_id=? ORDER BY epoch DESC LIMIT 1`, req.Session.SessionID, req.AgentID).
		Scan(&e.Number, &e.Reason, &e.Budget, &e.TokensSent, &e.ReservedTokens, &e.CompactSignals, &e.Intent, &e.Closed, &e.LastFailure, &e.ToolCalls, &e.CandidateTokens, &e.AdmittedTokens, &e.BudgetHeld, &e.ContentionMeasured)
	missing := errors.Is(err, sql.ErrNoRows)
	if err != nil && !missing {
		return result, err
	}
	if req.Budget <= 0 {
		req.Budget = 2000
		if !missing {
			req.Budget = e.Budget
		}
	}
	reason := req.Reason
	if reason == "" || reason == "resume" {
		reason = "startup"
	}
	advance := !missing && (req.Reason == "clear" || req.Reason == "fork" || req.Reason == "rewind")
	if req.Reason == "compact" {
		if req.CompactSignal != 1 && req.CompactSignal != 2 && req.CompactSignal != 4 {
			return result, errors.New("invalid compaction signal")
		}
		advance = !missing && (e.Reason != "compact" || e.CompactSignals&req.CompactSignal != 0)
	}
	if advance {
		if err = settleSurfaceWindows(ctx, conn, req, &e, true); err != nil {
			return result, err
		}
		if _, err = conn.ExecContext(ctx, `UPDATE epochs SET closed=1 WHERE session_id=? AND agent_id=? AND epoch=?`, req.Session.SessionID, req.AgentID, e.Number); err != nil {
			return result, err
		}
		if err = closeHoldbacks(ctx, conn, req.Session.SessionID, req.AgentID, e.Number, stamp); err != nil {
			return result, err
		}
	}
	if advance {
		if err = countClosedProbes(ctx, conn, req, e.Number); err != nil {
			return result, err
		}
	}
	if missing || advance {
		number := 0
		if advance {
			number = e.Number + 1
		}
		e = Epoch{Number: number, Reason: reason, Budget: req.Budget, Intent: "investigating", ContentionMeasured: true}
		if req.Reason == "compact" {
			e.CompactSignals = req.CompactSignal
		}
		_, err = conn.ExecContext(ctx, `INSERT INTO epochs(session_id,agent_id,epoch,started_at,reason,budget,compact_signals,intent,contention_measured) VALUES(?,?,?,?,?,?,?,?,1)`, req.Session.SessionID, req.AgentID, e.Number, stamp, e.Reason, e.Budget, e.CompactSignals, e.Intent)
	} else if req.Reason == "compact" {
		e.CompactSignals |= req.CompactSignal
		_, err = conn.ExecContext(ctx, `UPDATE epochs SET compact_signals=? WHERE session_id=? AND agent_id=? AND epoch=?`, e.CompactSignals, req.Session.SessionID, req.AgentID, e.Number)
	}
	if err != nil {
		return result, err
	}
	if len(req.SurfaceTools) > 0 || req.EndEpoch {
		if err = settleSurfaceWindows(ctx, conn, req, &e, req.EndEpoch); err != nil {
			return result, err
		}
	}
	if err = observeHoldbacks(ctx, conn, req, e.Number, stamp); err != nil {
		return result, err
	}
	if req.EndEpoch {
		if err = closeHoldbacks(ctx, conn, req.Session.SessionID, req.AgentID, e.Number, stamp); err != nil {
			return result, err
		}
	}
	if req.Intent != "" {
		switch req.Intent {
		case "working", "investigating", "changing", "reproducing":
			e.Intent = req.Intent
		default:
			return result, errors.New("invalid intent")
		}
	}
	for _, digest := range append(append([]string{}, req.Commands...), req.FailedCommand) {
		if digest == "" {
			continue
		}
		if raw, err := hex.DecodeString(digest); err != nil || len(raw) != 32 {
			return result, errors.New("invalid command digest")
		}
	}
	for _, digest := range req.Commands {
		if digest == e.LastFailure && e.Intent != "changing" {
			e.Intent = "reproducing"
		}
	}
	if req.FailedCommand != "" {
		e.LastFailure = req.FailedCommand
	}
	if len(req.Commands) > 0 {
		_, err = conn.ExecContext(ctx, `UPDATE epochs SET last_failure=? WHERE session_id=? AND agent_id=? AND epoch=?`,
			e.LastFailure, req.Session.SessionID, req.AgentID, e.Number)
		if err != nil {
			return result, err
		}
	}
	e.Closed = req.EndEpoch
	if err = observeProbes(ctx, conn, req, e.Number, stamp); err != nil {
		return result, err
	}
	// Persist explicit merges. The entry codec has no successor field; callers
	// must obtain these from an authoritative merge operation, never prose.
	for old, next := range req.Aliases {
		if old == "" || next == "" || old == next || len(old) > 128 || len(next) > 128 || strings.ContainsRune(old, 0) || strings.ContainsRune(next, 0) {
			return result, errors.New("invalid alias")
		}
		_, err = conn.ExecContext(ctx, `INSERT INTO aliases VALUES(?,?,?,?) ON CONFLICT(project_id,checkout,old_id) DO UPDATE SET new_id=excluded.new_id`, req.Session.ProjectID, req.Session.Checkout, old, next)
		if err != nil {
			return result, err
		}
	}
	aliases := map[string]string{}
	rows, err := conn.QueryContext(ctx, `SELECT old_id,new_id FROM aliases WHERE project_id=? AND checkout=? LIMIT 10001`, req.Session.ProjectID, req.Session.Checkout)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var a, b string
		if err = rows.Scan(&a, &b); err != nil {
			break
		}
		aliases[a] = b
	}
	err = errors.Join(err, rows.Err(), rows.Close())
	if err != nil {
		return result, err
	}
	if len(aliases) > 10000 {
		return result, errors.New("alias bound exceeded")
	}
	canonical := func(id string) (string, error) {
		seen := map[string]bool{}
		for aliases[id] != "" {
			if seen[id] || len(seen) >= 64 {
				return "", errors.New("alias cycle or chain too long")
			}
			seen[id] = true
			id = aliases[id]
		}
		return id, nil
	}
	for id := range aliases {
		if _, err = canonical(id); err != nil {
			return result, err
		}
	}
	present := map[string]bool{}
	presentHashes := map[string]string{}
	if len(req.Candidates) > 0 {
		err = conn.QueryRowContext(ctx, `SELECT coalesce(sum(tokens_sent+reserved_tokens),0) FROM epochs WHERE session_id=? AND agent_id=?`, req.Session.SessionID, req.AgentID).Scan(&e.SessionTokens)
		if err != nil {
			return result, err
		}
	}
	// logged keeps one withheld or held-back row per entry per epoch, and
	// corrected one correction, so repeated moments don't grow the table.
	logged := map[string]bool{}
	blockedIDs := map[string][]string{}
	corrected := map[string]bool{}
	receiptEntries, sentIDs := map[string]string{}, map[string]bool{}
	rows, err = conn.QueryContext(ctx, `SELECT id,entry_id,action,moment,content_hash FROM deliveries WHERE session_id=? AND agent_id=? AND epoch=? AND project_id=? AND checkout=? LIMIT 20000`, req.Session.SessionID, req.AgentID, e.Number, req.Session.ProjectID, req.Session.Checkout)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var receipt, id, action, moment, hash string
		if err = rows.Scan(&receipt, &id, &action, &moment, &hash); err != nil {
			break
		}
		rawID := id
		id, err = canonical(id)
		if err != nil {
			break
		}
		switch {
		case moment == "correction":
			corrected[id] = true
		case action == "given" || action == "replaced":
			receiptEntries[receipt] = rawID
			sentIDs[id] = true
			present[id] = true
			presentHashes[id] = hash
		case action == "shadow":
			// A shadow receipt counts toward once-per-epoch, but the agent never
			// saw it, so nothing can be corrected.
			present[id] = true
			presentHashes[id] = hash
		default:
			logged[id+"\x00"+action] = true
			if action == "held-back" || action == "withheld" {
				blockedIDs[id] = append(blockedIDs[id], rawID)
			}
		}
	}
	err = errors.Join(err, rows.Err(), rows.Close())
	if err != nil {
		return result, err
	}
	newID := hooks.newID
	if newID == nil {
		newID = receiptID
	}
	block, err := newID()
	if err != nil {
		return result, err
	}
	if req.OnceEntry != "" && present[req.OnceEntry] {
		req.Candidates = nil
	}
	familyCost := map[string]int{}
	for _, c := range req.Candidates {
		if c.Parent != "" && (c.Action == "" || c.Action == "given" || c.Action == "replaced") {
			familyCost[c.Parent] += c.Tokens
		}
	}
	next("record-admission-write")
	usedLanes := map[string]int{}
	if req.Lanes && len(req.Candidates) > 0 {
		usedLanes, err = laneUsage(ctx, conn, req, e.Number)
		if err != nil {
			return result, err
		}
	}
	approved := map[string]bool{}
	for _, c := range req.Candidates {
		if c.Surface == "" {
			c.Surface = SurfaceForMoment(c.Moment)
		}
		if !ValidSurface(c.Surface) {
			return result, errors.New("invalid delivery surface")
		}
		if c.Mode == "" && req.SurfaceMode != nil {
			c.Mode = req.SurfaceMode(c.Surface)
		}
		if c.Mode == "" {
			c.Mode = SurfaceDefault(c.Surface)
		}
		if _, err = conn.ExecContext(ctx, `INSERT OR IGNORE INTO surface_gates(project_id,surface,minimum_avoided_delta,minimum_cost_sessions,no_harm_rise) VALUES(?,?,?,?,?)`, req.Session.ProjectID, c.Surface, SurfaceKeepRule(c.Surface).AvoidedDelta, SurfaceKeepRule(c.Surface).CostSessions, SurfaceKeepRule(c.Surface).NoHarmRise); err != nil {
			return result, err
		}
		var gateState string
		gateErr := conn.QueryRowContext(ctx, `SELECT state FROM surface_gates WHERE project_id=? AND surface=?`, req.Session.ProjectID, c.Surface).Scan(&gateState)
		if gateErr != nil && !errors.Is(gateErr, sql.ErrNoRows) {
			return result, gateErr
		}
		if c.Mode == "off" || gateState == "off" {
			continue
		}
		if c.Mode == "trial" {
			if c.Mode, err = trialMode(ctx, conn, req, c.Surface, gateState); err != nil {
				return result, err
			}
		}
		if c.Mode != "on" && c.Mode != "shadow" {
			return result, errors.New("invalid surface mode")
		}
		if len(c.Title) > 4096 || len(c.Kind) > 32 || len(c.Level) > 16 ||
			len(c.Detail) > 64 || len(c.Parent) > 128 ||
			strings.ContainsRune(c.Title+c.Kind+c.Level+c.Detail+c.Parent, 0) ||
			c.EntryID == "" || len(c.EntryID) > 128 || strings.ContainsRune(c.EntryID, 0) ||
			len(c.ContentHash) > 256 || strings.ContainsRune(c.ContentHash, 0) ||
			c.Tokens < 0 || c.Tokens > 1000000 {
			return result, errors.New("invalid delivery candidate")
		}
		id, err := canonical(c.EntryID)
		if err != nil {
			return result, err
		}
		if c.SessionOnce || c.SessionMax > 0 {
			var given, entry int
			err = conn.QueryRowContext(ctx, `SELECT count(*),coalesce(sum(entry_id=?),0) FROM deliveries WHERE session_id=? AND agent_id=? AND surface=? AND action IN ('given','replaced','shadow')`, c.EntryID, req.Session.SessionID, req.AgentID, c.Surface).Scan(&given, &entry)
			if err != nil {
				return result, err
			}
			if (c.SessionOnce && entry > 0) || (c.SessionMax > 0 && given >= c.SessionMax) {
				continue
			}
		}
		if c.Correction {
			if !sentIDs[id] || corrected[id] || (c.CorrectionFor != "" && receiptEntries[c.CorrectionFor] != c.EntryID) {
				continue
			}
			c.Action, c.Reserved = "withheld", true
		} else if present[id] && !c.Resend && c.Action != "control" {
			continue
		}
		if c.Action == "" {
			c.Action = "given"
		}
		sends := c.Action == "given" || c.Action == "replaced"
		familyApproved := c.Parent != "" && approved[c.Parent]
		if sends && c.Parent != "" {
			parent, err := canonical(c.Parent)
			if err != nil {
				return result, err
			}
			if !present[parent] {
				c.Action, c.Detail, sends = "withheld", "parent", false
			}
		}
		if sends && req.Similar != nil && !c.Correction {
			var rows []GivenRow
			for id := range present {
				rows = append(rows, GivenRow{EntryID: id, ContentHash: presentHashes[id]})
			}
			sort.Slice(rows, func(i, j int) bool { return rows[i].EntryID < rows[j].EntryID })
			if why := req.Similar(c, rows); why != "" {
				c.Action, c.Detail, c.Tokens, sends = "withheld", why, 0, false
			}
		}
		c.Lane = "legacy"
		if req.Lanes {
			c.Lane = LaneFor(c)
		}
		cost := c
		cost.Tokens += familyCost[c.EntryID]
		offered := sends || c.Detail == "parent" || (c.Action == "held-back" && c.Detail == "moment-budget")
		budgetOnly := false
		if sends && !familyApproved && !c.Exempt && !c.Reserved {
			capacity := e.TokensSent+cost.Tokens <= e.Budget
			if req.Lanes {
				capacity = usedLanes[c.Lane]+cost.Tokens <= LaneLimit(c.Lane, e.Budget) && (usedLanes["legacy"] == 0 || e.TokensSent+cost.Tokens <= e.Budget)
			}
			score := req.Admit == nil || req.Admit(e, cost)
			budgetOnly = !capacity && score
			if !capacity || !score {
				c.Action = "held-back"
				if budgetOnly {
					c.Detail = "epoch-budget"
					if req.Lanes {
						c.Detail = "lane-budget"
					}
				} else if !score {
					c.Detail = "admission"
				}
				sends = false
			}
		}
		if offered && !c.Correction {
			if req.Lanes {
				if err = recordLaneOffer(ctx, conn, req, e.Number, id, c.Lane, c.Tokens, budgetOnly); err != nil {
					return result, err
				}
			}
			if err = recordEpochOffer(ctx, conn, req, &e, id, c.Tokens, budgetOnly); err != nil {
				return result, err
			}
		}
		if !sends && !c.Correction {
			key := id + "\x00" + c.Action
			if c.Moment == "prompt-arm" {
				target, targetErr := surfaceTargetJSON(c.Target)
				if targetErr != nil {
					return result, targetErr
				}
				if logged[key] {
					var duplicate bool
					err = conn.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM deliveries d JOIN surface_windows w ON w.delivery_id=d.id WHERE d.session_id=? AND d.agent_id=? AND d.epoch=? AND d.project_id=? AND d.checkout=? AND d.entry_id=? AND d.moment='prompt-arm' AND d.action='held-back' AND d.content_hash=? AND w.target=?)`, req.Session.SessionID, req.AgentID, e.Number, req.Session.ProjectID, req.Session.Checkout, id, c.ContentHash, target).Scan(&duplicate)
					if err != nil {
						return result, err
					}
					if duplicate {
						continue
					}
				}
				key += "\x00" + c.ContentHash + "\x00" + target
			}
			if logged[key] {
				continue
			}
			logged[key] = true
		}
		if sends && c.Mode == "shadow" {
			c.Action = "shadow"
		}
		if c.Correction && c.Mode == "shadow" {
			c.Action = "shadow"
		}
		c.Mode = "" // policy is not part of a receipt; only the action differs
		receipt, err := newID()
		if err != nil {
			return result, err
		}
		if sends && c.Action != "shadow" && c.EntryHash != "" && len(c.EntryHash) <= 80 && len(req.Branch) <= 512 && len(req.Head) <= 64 {
			var verdict, inputs string
			_ = conn.QueryRowContext(ctx, "SELECT verdict,inputs_hash FROM verdicts WHERE project_id=? AND checkout=? AND entry_id=?", req.Session.ProjectID, req.Session.Checkout, c.EntryID).Scan(&verdict, &inputs)
			data, _ := json.Marshal(AdviceContext{Version: 1, Branch: req.Branch, Head: req.Head, EntryHash: c.EntryHash, Verdict: verdict, InputsHash: inputs})
			c.Detail = string(data)
		}
		_, err = conn.ExecContext(ctx, `INSERT INTO deliveries(id,session_id,agent_id,epoch,ts,moment,entry_id,form,tokens,action,content_hash,block_id,project_id,checkout,detail,title,kind,level,surface,lane) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, receipt, req.Session.SessionID, req.AgentID, e.Number, stamp, c.Moment, c.EntryID, c.Form, c.Tokens, c.Action, c.ContentHash, block, req.Session.ProjectID, req.Session.Checkout, c.Detail, c.Title, c.Kind, c.Level, c.Surface, c.Lane)
		if err != nil {
			return result, err
		}
		result.Receipts = append(result.Receipts, Receipt{c, receipt, block})
		if err = addSurfaceWindow(ctx, conn, req, e, Receipt{c, receipt, block}); err != nil {
			return result, err
		}
		if c.Correction {
			corrected[id] = true
			e.SessionTokens += c.Tokens
			e.ReservedTokens += c.Tokens
			continue
		}
		if sends {
			usedLanes[c.Lane] += c.Tokens
			approved[c.EntryID] = true
			if c.Action != "shadow" {
				err = probeCounter(ctx, conn, stamp[:10], req.Session.Agent, "delivered")
			}
			if err != nil {
				return result, err
			}
			for _, oldID := range blockedIDs[id] {
				if err = deliveredLater(ctx, conn, req, e.Number, oldID, stamp); err != nil {
					return result, err
				}
			}
			present[id] = true
			presentHashes[id] = c.ContentHash
			e.SessionTokens += c.Tokens
			if c.Reserved {
				e.ReservedTokens += c.Tokens
			} else {
				e.TokensSent += c.Tokens
			}
		}
	}
	for _, c := range req.Conflicts {
		if present[c.Winner] {
			if _, err = conn.ExecContext(ctx, `INSERT OR IGNORE INTO delivery_conflicts VALUES(?,?,?,?,?,?,?,?)`, req.Session.SessionID, req.AgentID, e.Number, req.Session.ProjectID, req.Session.Checkout, c.Winner, c.Loser, c.Reason); err != nil {
				return result, err
			}
		}
	}
	if req.EndEpoch {
		if err = countClosedProbes(ctx, conn, req, e.Number); err != nil {
			return result, err
		}
	}
	e.AdmittedTokens = e.TokensSent + e.ReservedTokens
	_, err = conn.ExecContext(ctx, `UPDATE epochs SET tokens_sent=?,reserved_tokens=?,intent=?,closed=?,tool_calls=?,candidate_tokens=?,admitted_tokens=?,budget_held=? WHERE session_id=? AND agent_id=? AND epoch=?`, e.TokensSent, e.ReservedTokens, e.Intent, e.Closed, e.ToolCalls, e.CandidateTokens, e.AdmittedTokens, e.BudgetHeld, req.Session.SessionID, req.AgentID, e.Number)
	if err != nil {
		return result, err
	}
	if req.Reason == "startup" || req.Reason == "clear" {
		if err = pruneDelivery(ctx, conn, req.Now.Add(-30*24*time.Hour).UTC().Format(time.RFC3339Nano), req.KeepSession); err != nil {
			return result, err
		}
	}
	next("record-surface-eval")
	if !req.Offline && (len(req.SurfaceTools) > 0 || req.EndEpoch) {
		result.Notices, err = evaluateSurfaceGates(ctx, conn, req.Session.ProjectID)
		if err != nil {
			return result, err
		}
	}
	next("record-surface-gates")
	if req.Notify && !req.Offline {
		result.Notices, err = claimSurfaceNotices(ctx, conn, req.Session.ProjectID)
		if err != nil {
			return result, err
		}
	}
	var offSurfaces []string
	offRows, offErr := conn.QueryContext(ctx, `SELECT surface FROM surface_gates WHERE project_id=? AND state='off' LIMIT 32`, req.Session.ProjectID)
	if offErr != nil {
		return result, offErr
	}
	for offRows.Next() {
		var id string
		if err = offRows.Scan(&id); err != nil {
			break
		}
		offSurfaces = append(offSurfaces, id)
	}
	if err = errors.Join(err, offRows.Err(), offRows.Close()); err != nil {
		return result, err
	}
	next("record-surface-hint")
	cleanupHint, hintErr := hooks.syncSurfacePending(ctx, conn, req)
	if hintErr != nil {
		err = hintErr
		return result, err
	}
	committed := false
	defer func() { cleanupHint(committed) }()
	next("record-commit")
	if _, err = conn.ExecContext(ctx, "COMMIT"); err != nil {
		return DeliveryResult{}, err
	}
	committed = true
	hooks.noteAnchorHints(req, result.Receipts)
	if len(offSurfaces) > 0 {
		hooks.publishSurfaceOff(req.Session.ProjectID, offSurfaces)
	}
	result.Epoch = e
	return result, nil
}

func receiptID() (string, error) {
	var id [12]byte
	if _, err := rand.Read(id[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(id[:]), nil
}

// A start removes at most 256 followups, 256 receipts and 64 empty epochs.
// No cascading delete may turn a small prune into unbounded work. Other
// session records belong to their owners, so sessions themselves stay intact.
func pruneDelivery(ctx context.Context, c *sql.Conn, cutoff string, keep func(string, string) bool) error {
	rows, err := c.QueryContext(ctx, `SELECT session_id,agent FROM sessions WHERE last_seen_at<? ORDER BY last_seen_at LIMIT 64`, cutoff)
	if err != nil {
		return err
	}
	var ids []any
	for rows.Next() {
		var id, agent string
		if err = rows.Scan(&id, &agent); err != nil {
			break
		}
		if keep == nil || !keep(agent, id) {
			ids = append(ids, id)
		}
	}
	err = errors.Join(err, rows.Err(), rows.Close())
	if err != nil {
		return err
	}
	if len(ids) == 0 {
		return nil
	}
	marks := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := append(ids, cutoff)
	for _, q := range []string{
		`DELETE FROM lane_offers WHERE rowid IN (SELECT o.rowid FROM lane_offers o JOIN epochs e ON e.session_id=o.session_id AND e.agent_id=o.agent_id AND e.epoch=o.epoch WHERE o.session_id IN (` + marks + `) AND e.started_at<? LIMIT 256)`,
		`DELETE FROM surface_cost_checks WHERE rowid IN (SELECT o.rowid FROM surface_cost_checks o JOIN sessions s ON s.session_id=o.session_id WHERE o.session_id IN (` + marks + `) AND s.last_seen_at<? LIMIT 256)`,
		`DELETE FROM epoch_offers WHERE rowid IN (SELECT o.rowid FROM epoch_offers o JOIN epochs e ON e.session_id=o.session_id AND e.agent_id=o.agent_id AND e.epoch=o.epoch WHERE o.session_id IN (` + marks + `) AND e.started_at<? LIMIT 256)`,
		`DELETE FROM surface_session_first WHERE rowid IN (SELECT f.rowid FROM surface_session_first f JOIN sessions s ON s.session_id=f.session_id WHERE f.session_id IN (` + marks + `) AND s.last_seen_at<? LIMIT 256)`,
		`DELETE FROM delivery_conflicts WHERE rowid IN (SELECT c.rowid FROM delivery_conflicts c JOIN epochs e ON e.session_id=c.session_id AND e.agent_id=c.agent_id AND e.epoch=c.epoch WHERE c.session_id IN (` + marks + `) AND e.started_at<? LIMIT 256)`,
		`DELETE FROM surface_windows WHERE delivery_id IN (SELECT d.id FROM deliveries d WHERE d.session_id IN (` + marks + `) AND d.ts<? LIMIT 256)`,
		`DELETE FROM surface_firings WHERE rowid IN (SELECT f.rowid FROM surface_firings f JOIN epochs e ON e.session_id=f.session_id AND e.agent_id=f.agent_id AND e.epoch=f.epoch WHERE f.session_id IN (` + marks + `) AND e.started_at<? AND NOT EXISTS(SELECT 1 FROM surface_windows w WHERE w.firing_id=f.id) LIMIT 256)`,
		`DELETE FROM delivery_touches WHERE delivery_id IN (SELECT d.id FROM deliveries d WHERE d.session_id IN (` + marks + `) AND d.ts<? LIMIT 256)`,
		`DELETE FROM epoch_files WHERE rowid IN (SELECT f.rowid FROM epoch_files f JOIN epochs e ON e.session_id=f.session_id AND e.agent_id=f.agent_id AND e.epoch=f.epoch WHERE f.session_id IN (` + marks + `) AND e.started_at<? LIMIT 256)`,
		`DELETE FROM followups WHERE id IN (SELECT f.id FROM followups f JOIN deliveries d ON d.id=f.delivery_id WHERE d.session_id IN (` + marks + `) AND d.ts<? LIMIT 256)`,
		`DELETE FROM deliveries WHERE id IN (SELECT d.id FROM deliveries d WHERE d.session_id IN (` + marks + `) AND d.ts<? AND NOT EXISTS(SELECT 1 FROM followups f WHERE f.delivery_id=d.id) AND NOT EXISTS(SELECT 1 FROM delivery_touches t WHERE t.delivery_id=d.id) LIMIT 256)`,
		`DELETE FROM epochs WHERE (session_id,agent_id,epoch) IN (SELECT e.session_id,e.agent_id,e.epoch FROM epochs e WHERE e.session_id IN (` + marks + `) AND e.started_at<? AND NOT EXISTS(SELECT 1 FROM epoch_offers o WHERE o.session_id=e.session_id AND o.agent_id=e.agent_id AND o.epoch=e.epoch) AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.session_id=e.session_id AND d.agent_id=e.agent_id AND d.epoch=e.epoch) AND NOT EXISTS(SELECT 1 FROM delivery_conflicts c WHERE c.session_id=e.session_id AND c.agent_id=e.agent_id AND c.epoch=e.epoch) LIMIT 64)`,
	} {
		if _, err := c.ExecContext(ctx, q, args...); err != nil {
			return fmt.Errorf("prune delivery: %w", err)
		}
	}
	return nil
}

// Presence lists the entries given (or replaced) in the current epoch of a
// session's agent, with the blocks that carried them and aliases resolved,
// without taking the writer lock.
// Callers use it to drop repeats before packing; CheckAndMark rechecks under
// the lock, so a race costs at most one skipped item, never a double send.
func (hooks *Hooks) Presence(sessionID, agentID, projectID, checkout string) (map[string][]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), hooks.budget.reader)
	defer cancel()
	present := map[string][]string{}
	var epoch int
	err := hooks.db.QueryRowContext(ctx, `SELECT epoch FROM epochs WHERE session_id=? AND agent_id=? ORDER BY epoch DESC LIMIT 1`, sessionID, agentID).Scan(&epoch)
	if errors.Is(err, sql.ErrNoRows) {
		return present, nil
	}
	if err != nil {
		return nil, err
	}
	aliases := map[string]string{}
	rows, err := hooks.db.QueryContext(ctx, `SELECT old_id,new_id FROM aliases WHERE project_id=? AND checkout=? LIMIT 10001`, projectID, checkout)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var a, b string
		if err = rows.Scan(&a, &b); err != nil {
			break
		}
		aliases[a] = b
	}
	if err = errors.Join(err, rows.Err(), rows.Close()); err != nil {
		return nil, err
	}
	rows, err = hooks.db.QueryContext(ctx, `SELECT entry_id,block_id FROM deliveries WHERE session_id=? AND agent_id=? AND epoch=? AND project_id=? AND checkout=? AND action IN ('given','replaced','shadow') AND moment<>'correction' LIMIT 20000`, sessionID, agentID, epoch, projectID, checkout)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id, block string
		if err = rows.Scan(&id, &block); err != nil {
			break
		}
		for hops := 0; aliases[id] != "" && hops < 64; hops++ {
			id = aliases[id]
		}
		present[id] = append(present[id], block)
	}
	return present, errors.Join(err, rows.Err(), rows.Close())
}

// GivenRow is one entry given (or replaced) in an epoch.
type GivenRow struct {
	EntryID, Form, ContentHash, Moment, BlockID string
}

// latestEpoch returns the newest epoch number of a session's agent.
func (hooks *Hooks) latestEpoch(ctx context.Context, sessionID, agentID string) (int, bool, error) {
	var n int
	err := hooks.db.QueryRowContext(ctx, `SELECT epoch FROM epochs WHERE session_id=? AND agent_id=? ORDER BY epoch DESC LIMIT 1`, sessionID, agentID).Scan(&n)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	return n, err == nil, err
}

// EpochGiven lists what an epoch gave in one checkout, oldest first; epoch -1
// means the newest. Corrections are not deliveries and are left out.
func (hooks *Hooks) EpochGiven(sessionID, agentID, projectID, checkout string, epoch int) ([]GivenRow, int, error) {
	return hooks.EpochSelected(sessionID, agentID, projectID, checkout, epoch, false)
}

// EpochSelected optionally includes virtual shadow presence. Live recovery must
// never correct or recover text that the model was never given.
func (hooks *Hooks) EpochSelected(sessionID, agentID, projectID, checkout string, epoch int, shadow bool) ([]GivenRow, int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), hooks.budget.reader)
	defer cancel()
	if epoch < 0 {
		n, ok, err := hooks.latestEpoch(ctx, sessionID, agentID)
		if err != nil || !ok {
			return nil, 0, err
		}
		epoch = n
	}
	rows, err := hooks.db.QueryContext(ctx, `SELECT entry_id,form,content_hash,moment,block_id FROM deliveries WHERE session_id=? AND agent_id=? AND epoch=? AND project_id=? AND checkout=? AND (action IN ('given','replaced') OR (? AND action='shadow')) AND moment<>'correction' ORDER BY ts,rowid LIMIT 2000`, sessionID, agentID, epoch, projectID, checkout, shadow)
	if err != nil {
		return nil, epoch, err
	}
	var out []GivenRow
	seen := map[string]bool{}
	for rows.Next() {
		var g GivenRow
		if err = rows.Scan(&g.EntryID, &g.Form, &g.ContentHash, &g.Moment, &g.BlockID); err != nil {
			break
		}
		if !seen[g.EntryID] {
			seen[g.EntryID] = true
			out = append(out, g)
		}
	}
	return out, epoch, errors.Join(err, rows.Err(), rows.Close())
}

// EpochFiles lists the files edited in an epoch in one checkout.
func (hooks *Hooks) EpochFiles(sessionID, agentID, projectID, checkout string, epoch int) ([]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), hooks.budget.reader)
	defer cancel()
	rows, err := hooks.db.QueryContext(ctx, `SELECT path FROM epoch_files WHERE session_id=? AND agent_id=? AND epoch=? AND project_id=? AND checkout=? ORDER BY path LIMIT 512`, sessionID, agentID, epoch, projectID, checkout)
	if err != nil {
		return nil, err
	}
	var out []string
	for rows.Next() {
		var p string
		if err = rows.Scan(&p); err != nil {
			break
		}
		out = append(out, p)
	}
	return out, errors.Join(err, rows.Err(), rows.Close())
}

// NoteEdits records files edited in the current epoch, for the recovery block
// after compaction. Callers pass only files some entry's scope covers. At most
// 64 paths per call and 512 per epoch; with no epoch yet, nothing is written.
func (hooks *Hooks) NoteEdits(session Session, agentID string, paths []string) error {
	if hooks.counterOnly || len(paths) == 0 {
		return nil
	}
	if len(paths) > 64 {
		paths = paths[:64]
	}
	ctx, cancel := context.WithTimeout(context.Background(), hooks.budget.writer)
	defer cancel()
	conn, err := hooks.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if err = hooks.retryStatement(ctx, conn, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	defer func() { _, _ = conn.ExecContext(context.Background(), "ROLLBACK") }()
	var epoch, count int
	err = conn.QueryRowContext(ctx, `SELECT epoch FROM epochs WHERE session_id=? AND agent_id=? ORDER BY epoch DESC LIMIT 1`, session.SessionID, agentID).Scan(&epoch)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if err = conn.QueryRowContext(ctx, `SELECT count(*) FROM epoch_files WHERE session_id=? AND agent_id=? AND epoch=?`, session.SessionID, agentID, epoch).Scan(&count); err != nil {
		return err
	}
	for _, p := range paths {
		if count >= 512 {
			break
		}
		if p == "" || len(p) > 4096 || strings.ContainsRune(p, 0) {
			continue
		}
		res, err := conn.ExecContext(ctx, `INSERT OR IGNORE INTO epoch_files VALUES(?,?,?,?,?,?)`, session.SessionID, agentID, epoch, session.ProjectID, session.Checkout, p)
		if err != nil {
			return err
		}
		if n, _ := res.RowsAffected(); n > 0 {
			count++
		}
	}
	_, err = conn.ExecContext(ctx, "COMMIT")
	return err
}
