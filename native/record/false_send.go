package record

import (
	"context"
	"database/sql"
	"errors"
)

// Freeze the existing local estimate once at closure. Only aggregate counts
// cross the telemetry boundary; this is an absence-of-evidence proxy, not a
// judgement of relevance or causal savings.
func countClosedProbes(ctx context.Context, c *sql.Conn, req DeliveryRequest, epoch int) error {
	if req.Offline || req.Session.Agent != "claude-code" && req.Session.Agent != "codex" {
		return nil
	}
	var claimed int
	err := c.QueryRowContext(ctx, `UPDATE epochs SET false_send_counted=1 WHERE session_id=? AND agent_id=? AND epoch=? AND false_send_counted=0 RETURNING epoch`, req.Session.SessionID, req.AgentID, epoch).Scan(&claimed)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var total, empty int
	err = c.QueryRowContext(ctx, `SELECT count(*),coalesce(sum(CASE WHEN NOT EXISTS(SELECT 1 FROM followups f WHERE f.delivery_id=d.id) AND NOT EXISTS(SELECT 1 FROM delivery_touches t WHERE t.delivery_id=d.id) THEN 1 ELSE 0 END),0) FROM deliveries d WHERE d.session_id=? AND d.agent_id=? AND d.epoch=? AND d.action IN ('given','replaced') AND d.moment<>'correction'`, req.Session.SessionID, req.AgentID, epoch).Scan(&total, &empty)
	if err != nil {
		return err
	}
	for _, count := range []struct {
		name string
		n    int
	}{{"knowledge.closed_deliveries", total}, {"knowledge.false_send_estimate", empty}} {
		if count.n == 0 {
			continue
		}
		_, err = c.ExecContext(ctx, `INSERT INTO counters_go(day,name,value) VALUES(?,?,?) ON CONFLICT(day,name) DO UPDATE SET value=min(2147483647,value+excluded.value)`, req.Now.UTC().Format("2006-01-02"), "agent:"+req.Session.Agent+":"+count.name, count.n)
		if err != nil {
			return err
		}
	}
	return nil
}
