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
	rows, err := h.db.QueryContext(ctx, `SELECT d.id,d.session_id,s.agent,d.agent_id FROM deliveries d JOIN epochs e ON e.session_id=d.session_id AND e.agent_id=d.agent_id AND e.epoch=d.epoch JOIN sessions s ON s.session_id=d.session_id WHERE d.entry_id=? AND d.project_id=? AND d.checkout=? AND d.action IN ('given','replaced') AND d.moment<>'correction' AND e.closed=0 AND s.paused=0 AND s.last_seen_at>=? AND (?='' OR d.session_id=?) ORDER BY d.rowid DESC LIMIT 2`, entry, project, checkout, time.Now().Add(-24*time.Hour).UTC().Format(time.RFC3339Nano), session, session)
	if err != nil {
		return false, err
	}
	var found []DeliveryRequest
	for rows.Next() {
		var id, s, agent, sub string
		if err = rows.Scan(&id, &s, &agent, &sub); err != nil {
			break
		}
		found = append(found, DeliveryRequest{Session: Session{SessionID: s, Agent: agent, ProjectID: project, Checkout: checkout}, AgentID: sub, Probes: []FollowupObservation{{ReceiptID: id, EntryID: entry, Kind: kind}}})
	}
	err = errors.Join(err, rows.Err(), rows.Close())
	if err != nil {
		return false, err
	}
	if len(found) != 1 {
		return false, nil
	}
	_, err = h.CheckAndMark(found[0])
	return err == nil, err
}
