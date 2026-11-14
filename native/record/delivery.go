package record

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"
)

// Epoch is the single budget and presence boundary for one agent's context.
type Epoch struct {
	Number                                             int
	Reason                                             string
	Budget, TokensSent, ReservedTokens, CompactSignals int
	SessionTokens                                      int
}

// DeliveryCandidate is already gated and rendered by the controller. Admit is
// evaluated under the writer lock so parallel calls see the same budget.
type DeliveryCandidate struct {
	EntryID, Moment, Form, Action, ContentHash string
	Tokens                                     int
	Reserved, Exempt                           bool
	// Correction marks a short note that an entry given earlier in this
	// epoch no longer holds. It is written once per entry per epoch, only
	// when the entry was given, and always in the reserved lane.
	Correction bool
	// Resend gives an entry again although the ledger has it this epoch: the
	// transcript shows the agent no longer has it (a rewind).
	Resend bool
}
type Receipt struct {
	DeliveryCandidate
	ID, BlockID string
}
type DeliveryRequest struct {
	Session Session
	AgentID string
	// Empty reason keeps the current epoch. Resume likewise never advances it.
	Reason string
	// CompactSignal is 1 for SessionStart and 2 for PostCompact. Different
	// signals confirm a transition; a repeated signal starts the next cycle.
	CompactSignal int
	Budget        int
	Now           time.Time
	Candidates    []DeliveryCandidate
	Aliases       map[string]string
	Admit         func(Epoch, DeliveryCandidate) bool
	// KeepSession conservatively protects file-heartbeat sessions whose
	// no-op calls deliberately do not open SQLite. Called at most 64 times.
	KeepSession func(agent, sessionID string) bool
}
type DeliveryResult struct {
	Epoch    Epoch
	Receipts []Receipt
}

// CheckAndMark commits the lifecycle, aliases, dedupe, admission, receipts and
// counters together. Nothing may be rendered until this returns successfully.
func (hooks *Hooks) CheckAndMark(req DeliveryRequest) (result DeliveryResult, err error) {
	defer func() {
		if err != nil {
			result = DeliveryResult{}
		}
	}()
	if hooks.counterOnly || req.Session.SessionID == "" || req.Session.Agent == "" || req.Session.ProjectID == "" || req.Session.Checkout == "" {
		return result, errors.New("invalid delivery session")
	}
	for _, field := range []string{req.Session.SessionID, req.Session.Agent, req.AgentID, req.Session.ProjectID, req.Session.Checkout} {
		if len(field) > 4096 || strings.ContainsRune(field, 0) {
			return result, errors.New("invalid delivery identity")
		}
	}
	if len(req.Candidates) > 1000 || len(req.Aliases) > 10000 {
		return result, errors.New("delivery batch exceeds bound")
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
	if err = hooks.retryStatement(ctx, conn, "BEGIN IMMEDIATE"); err != nil {
		return result, err
	}
	defer func() { _, _ = conn.ExecContext(context.Background(), "ROLLBACK") }()
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
	err = conn.QueryRowContext(ctx, `SELECT epoch,reason,budget,tokens_sent,reserved_tokens,compact_signals FROM epochs
 WHERE session_id=? AND agent_id=? ORDER BY epoch DESC LIMIT 1`, req.Session.SessionID, req.AgentID).
		Scan(&e.Number, &e.Reason, &e.Budget, &e.TokensSent, &e.ReservedTokens, &e.CompactSignals)
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
	if missing || advance {
		number := 0
		if advance {
			number = e.Number + 1
		}
		e = Epoch{Number: number, Reason: reason, Budget: req.Budget}
		if req.Reason == "compact" {
			e.CompactSignals = req.CompactSignal
		}
		_, err = conn.ExecContext(ctx, `INSERT INTO epochs(session_id,agent_id,epoch,started_at,reason,budget,compact_signals) VALUES(?,?,?,?,?,?,?)`, req.Session.SessionID, req.AgentID, e.Number, stamp, e.Reason, e.Budget, e.CompactSignals)
	} else if req.Reason == "compact" {
		e.CompactSignals |= req.CompactSignal
		_, err = conn.ExecContext(ctx, `UPDATE epochs SET compact_signals=? WHERE session_id=? AND agent_id=? AND epoch=?`, e.CompactSignals, req.Session.SessionID, req.AgentID, e.Number)
	}
	if err != nil {
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
	if len(req.Candidates) > 0 {
		err = conn.QueryRowContext(ctx, `SELECT coalesce(sum(tokens_sent+reserved_tokens),0) FROM epochs WHERE session_id=? AND agent_id=?`, req.Session.SessionID, req.AgentID).Scan(&e.SessionTokens)
		if err != nil {
			return result, err
		}
	}
	// logged keeps one withheld or held-back row per entry per epoch, and
	// corrected one correction, so repeated moments don't grow the table.
	logged := map[string]bool{}
	corrected := map[string]bool{}
	rows, err = conn.QueryContext(ctx, `SELECT entry_id,action,moment FROM deliveries WHERE session_id=? AND agent_id=? AND epoch=? AND project_id=? AND checkout=? LIMIT 20000`, req.Session.SessionID, req.AgentID, e.Number, req.Session.ProjectID, req.Session.Checkout)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var id, action, moment string
		if err = rows.Scan(&id, &action, &moment); err != nil {
			break
		}
		id, err = canonical(id)
		if err != nil {
			break
		}
		switch {
		case moment == "correction":
			corrected[id] = true
		case action == "given" || action == "replaced":
			present[id] = true
		default:
			logged[id+"\x00"+action] = true
		}
	}
	err = errors.Join(err, rows.Err(), rows.Close())
	if err != nil {
		return result, err
	}
	block, err := receiptID()
	if err != nil {
		return result, err
	}
	for _, c := range req.Candidates {
		if c.EntryID == "" || len(c.EntryID) > 128 || strings.ContainsRune(c.EntryID, 0) || len(c.ContentHash) > 256 || strings.ContainsRune(c.ContentHash, 0) || c.Tokens < 0 || c.Tokens > 1000000 {
			return result, errors.New("invalid delivery candidate")
		}
		id, err := canonical(c.EntryID)
		if err != nil {
			return result, err
		}
		if c.Correction {
			if !present[id] || corrected[id] {
				continue
			}
			c.Action, c.Reserved = "withheld", true
		} else if present[id] && !c.Resend {
			continue
		}
		if c.Action == "" {
			c.Action = "given"
		}
		sends := c.Action == "given" || c.Action == "replaced"
		if sends && !c.Exempt && !c.Reserved && (e.TokensSent+c.Tokens > e.Budget || (req.Admit != nil && !req.Admit(e, c))) {
			c.Action = "held-back"
			sends = false
		}
		if !sends && !c.Correction {
			key := id + "\x00" + c.Action
			if logged[key] {
				continue
			}
			logged[key] = true
		}
		receipt, err := receiptID()
		if err != nil {
			return result, err
		}
		_, err = conn.ExecContext(ctx, `INSERT INTO deliveries(id,session_id,agent_id,epoch,ts,moment,entry_id,form,tokens,action,content_hash,block_id,project_id,checkout) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, receipt, req.Session.SessionID, req.AgentID, e.Number, stamp, c.Moment, c.EntryID, c.Form, c.Tokens, c.Action, c.ContentHash, block, req.Session.ProjectID, req.Session.Checkout)
		if err != nil {
			return result, err
		}
		result.Receipts = append(result.Receipts, Receipt{c, receipt, block})
		if c.Correction {
			corrected[id] = true
			e.SessionTokens += c.Tokens
			e.ReservedTokens += c.Tokens
			continue
		}
		if sends {
			present[id] = true
			e.SessionTokens += c.Tokens
			if c.Reserved {
				e.ReservedTokens += c.Tokens
			} else {
				e.TokensSent += c.Tokens
			}
		}
	}
	_, err = conn.ExecContext(ctx, `UPDATE epochs SET tokens_sent=?,reserved_tokens=? WHERE session_id=? AND agent_id=? AND epoch=?`, e.TokensSent, e.ReservedTokens, req.Session.SessionID, req.AgentID, e.Number)
	if err != nil {
		return result, err
	}
	if req.Reason == "startup" || req.Reason == "clear" {
		if err = pruneDelivery(ctx, conn, req.Now.Add(-30*24*time.Hour).UTC().Format(time.RFC3339Nano), req.KeepSession); err != nil {
			return result, err
		}
	}
	if _, err = conn.ExecContext(ctx, "COMMIT"); err != nil {
		return DeliveryResult{}, err
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
		`DELETE FROM epoch_files WHERE rowid IN (SELECT f.rowid FROM epoch_files f JOIN epochs e ON e.session_id=f.session_id AND e.agent_id=f.agent_id AND e.epoch=f.epoch WHERE f.session_id IN (` + marks + `) AND e.started_at<? LIMIT 256)`,
		`DELETE FROM followups WHERE id IN (SELECT f.id FROM followups f JOIN deliveries d ON d.id=f.delivery_id WHERE d.session_id IN (` + marks + `) AND d.ts<? LIMIT 256)`,
		`DELETE FROM deliveries WHERE id IN (SELECT d.id FROM deliveries d WHERE d.session_id IN (` + marks + `) AND d.ts<? AND NOT EXISTS(SELECT 1 FROM followups f WHERE f.delivery_id=d.id) LIMIT 256)`,
		`DELETE FROM epochs WHERE (session_id,agent_id,epoch) IN (SELECT e.session_id,e.agent_id,e.epoch FROM epochs e WHERE e.session_id IN (` + marks + `) AND e.started_at<? AND NOT EXISTS(SELECT 1 FROM deliveries d WHERE d.session_id=e.session_id AND d.agent_id=e.agent_id AND d.epoch=e.epoch) LIMIT 64)`,
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
	rows, err = hooks.db.QueryContext(ctx, `SELECT entry_id,block_id FROM deliveries WHERE session_id=? AND agent_id=? AND epoch=? AND project_id=? AND checkout=? AND action IN ('given','replaced') AND moment<>'correction' LIMIT 20000`, sessionID, agentID, epoch, projectID, checkout)
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
	ctx, cancel := context.WithTimeout(context.Background(), hooks.budget.reader)
	defer cancel()
	if epoch < 0 {
		n, ok, err := hooks.latestEpoch(ctx, sessionID, agentID)
		if err != nil || !ok {
			return nil, 0, err
		}
		epoch = n
	}
	rows, err := hooks.db.QueryContext(ctx, `SELECT entry_id,form,content_hash,moment,block_id FROM deliveries WHERE session_id=? AND agent_id=? AND epoch=? AND project_id=? AND checkout=? AND action IN ('given','replaced') AND moment<>'correction' ORDER BY ts,rowid LIMIT 2000`, sessionID, agentID, epoch, projectID, checkout)
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
