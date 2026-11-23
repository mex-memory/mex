package record

import (
	"context"
	"errors"
	"time"
)

// An explicit CLI action may annotate only an unambiguous active context.
// Missing/ambiguous sessions produce no observation, never a guessed receipt.
func (h *Hooks) ExplicitProbe(entry, kind, session, project, checkout string) (bool, error) {
	if kind != "opened" && kind != "wrong" {
		return false, errors.New("invalid explicit probe")
	}
	ctx, cancel := context.WithTimeout(context.Background(), h.budget.reader)
	defer cancel()
	var count int
	var id, s, agent, sub string
	err := h.db.QueryRowContext(ctx, `SELECT count(*),coalesce(min(id),''),coalesce(min(session_id),''),coalesce(min(agent),''),coalesce(min(agent_id),'')
 FROM (SELECT d.id,d.session_id,s.agent,d.agent_id FROM deliveries d JOIN epochs e ON e.session_id=d.session_id AND e.agent_id=d.agent_id AND e.epoch=d.epoch
 JOIN sessions s ON s.session_id=d.session_id WHERE d.entry_id=? AND d.project_id=? AND d.checkout=? AND d.action IN ('given','replaced')
 AND d.moment<>'correction' AND e.closed=0 AND s.paused=0 AND s.last_seen_at>=? AND (?='' OR d.session_id=?) LIMIT 2)`,
		entry, project, checkout, time.Now().Add(-24*time.Hour).UTC().Format(time.RFC3339Nano), session, session).Scan(&count, &id, &s, &agent, &sub)
	if err != nil {
		return false, err
	}
	if count != 1 {
		return false, nil
	}
	_, err = h.CheckAndMark(DeliveryRequest{Session: Session{SessionID: s, Agent: agent, ProjectID: project, Checkout: checkout},
		AgentID: sub, Probes: []FollowupObservation{{ReceiptID: id, EntryID: entry, Kind: kind}}})
	return err == nil, err
}

// SaveAgentRuleReport shares one database deadline across opening, attribution
// and writing. The CLI allows ten seconds, including process startup.
func SaveAgentRuleReport(location Location, entry, session, project, checkout, invocation, detail string, now time.Time) error {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	const busyMS = 1500
	h, err := openHookDatabaseWithin(ctx, location, budget{writerBusy: busyMS * time.Millisecond}, false, busyMS)
	if err != nil {
		return err
	}
	defer h.Close()
	conn, err := h.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if err = h.retryStatement(ctx, conn, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	defer conn.ExecContext(context.Background(), "ROLLBACK")

	var receipt string
	// The aggregate always returns a row, including when there are no stops.
	// Exhausting a rows iterator here could race its deadline-triggered close.
	q := `SELECT CASE WHEN count(*)=1 THEN min(id) ELSE '' END FROM (
 SELECT d.id FROM deliveries d JOIN epochs e ON e.session_id=d.session_id AND e.agent_id=d.agent_id AND e.epoch=d.epoch
 JOIN sessions s ON s.session_id=d.session_id WHERE d.entry_id=? AND d.project_id=? AND d.checkout=? AND d.agent_id=''
 AND d.action='given' AND d.moment='bump' AND e.closed=0 AND s.paused=0 AND s.last_seen_at>=? AND (?='' OR d.session_id=?)
 LIMIT 2)`
	if err = conn.QueryRowContext(ctx, q, entry, project, checkout, now.Add(-24*time.Hour).UTC().Format(time.RFC3339Nano), session, session).Scan(&receipt); err != nil {
		return err
	}
	if receipt == "" {
		// The control receipt and report commit together. This receipt is
		// bookkeeping for the report and does not enter delivery admission.
		sessionID := "mex:wrong:" + invocation
		stamp := now.UTC().Format(time.RFC3339)
		if receipt, err = receiptID(); err != nil {
			return err
		}
		if _, err = conn.ExecContext(ctx, `INSERT INTO sessions(session_id,agent,project_id,checkout,started_at,last_seen_at)
 VALUES(?,'cli',?,?,?,?)`, sessionID, project, checkout, stamp, stamp); err != nil {
			return err
		}
		if _, err = conn.ExecContext(ctx, "INSERT INTO epochs(session_id,epoch,started_at,closed) VALUES(?,1,?,1)", sessionID, stamp); err != nil {
			return err
		}
		if _, err = conn.ExecContext(ctx, `INSERT INTO deliveries(id,session_id,epoch,ts,moment,entry_id,form,tokens,action,project_id,checkout)
 VALUES(?, ?, 1, ?, 'agent-report', ?, 'pointer', 0, 'control', ?, ?)`, receipt, sessionID, stamp, entry, project, checkout); err != nil {
			return err
		}
	}
	if _, err = conn.ExecContext(ctx, `INSERT INTO followups(delivery_id,ts,kind,detail)
 SELECT ?,?,'wrong',? WHERE NOT EXISTS(SELECT 1 FROM followups WHERE delivery_id=? AND kind='wrong' AND detail=?)`,
		receipt, now.UTC().Format(time.RFC3339Nano), detail, receipt, detail); err != nil {
		return err
	}
	_, err = conn.ExecContext(ctx, "COMMIT")
	return err
}
