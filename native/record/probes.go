package record

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

// Probes contain receipt identities and closed kinds only. They never retain
// the code, command or prompt that produced an observation.
func observeProbes(ctx context.Context, c *sql.Conn, req DeliveryRequest, epoch int, stamp string) error {
	for _, o := range req.Probes {
		switch o.Kind {
		case "followed", "missed", "opened", "wrong":
		default:
			return errors.New("invalid probe kind")
		}
		if o.EntryID == "" || o.ReceiptID == "" || len(o.EntryID) > 128 || len(o.ReceiptID) > 128 || strings.ContainsRune(o.EntryID+o.ReceiptID, 0) {
			return errors.New("invalid probe identity")
		}
		result, err := c.ExecContext(ctx, `INSERT INTO followups(delivery_id,ts,kind)
 SELECT d.id,?,? FROM deliveries d WHERE d.id=? AND d.entry_id=?
 AND d.session_id=? AND d.agent_id=? AND d.epoch=? AND d.project_id=? AND d.checkout=?
 AND d.action IN ('given','replaced') AND d.moment<>'correction'
 AND NOT EXISTS(SELECT 1 FROM followups f WHERE f.delivery_id=d.id AND f.kind=?)`, stamp, o.Kind, o.ReceiptID, o.EntryID, req.Session.SessionID, req.AgentID, epoch, req.Session.ProjectID, req.Session.Checkout, o.Kind)
		if err != nil {
			return err
		}
		n, err := result.RowsAffected()
		if err != nil {
			return err
		}
		if n > 0 {
			if err = probeCounter(ctx, c, stamp[:10], req.Session.Agent, o.Kind); err != nil {
				return err
			}
		}
	}
	for _, id := range req.Touches {
		if len(id) > 128 || strings.ContainsRune(id, 0) {
			return errors.New("invalid touch identity")
		}
		if _, err := c.ExecContext(ctx, `INSERT OR IGNORE INTO delivery_touches SELECT id FROM deliveries WHERE id=? AND session_id=? AND agent_id=? AND epoch=? AND project_id=? AND checkout=? AND action IN ('given','replaced') AND moment<>'correction'`, id, req.Session.SessionID, req.AgentID, epoch, req.Session.ProjectID, req.Session.Checkout); err != nil {
			return err
		}
	}
	return nil
}

func probeCounter(ctx context.Context, c *sql.Conn, day, agent, kind string) error {
	if !telemetryAgent(agent) {
		return nil
	}
	_, err := c.ExecContext(ctx, `INSERT INTO counters_go(day,name,value) VALUES(?,?,1) ON CONFLICT(day,name) DO UPDATE SET value=min(2147483647,value+1)`, day, "agent:"+agent+":knowledge."+kind)
	return err
}

type ProbeRow struct{ ID, EntryID string }

// ProbeEntries is bounded and called only after a delivery/lifecycle call has
// already opened storage. A tool miss never opens SQLite to look for probes.
func (h *Hooks) ProbeEntries(session, agent, project, checkout string) ([]ProbeRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), h.budget.reader)
	defer cancel()
	rows, err := h.db.QueryContext(ctx, `SELECT id,entry_id FROM deliveries WHERE session_id=? AND agent_id=? AND epoch=(SELECT max(epoch) FROM epochs WHERE session_id=? AND agent_id=?) AND project_id=? AND checkout=? AND action IN ('given','replaced') AND moment<>'correction' ORDER BY rowid DESC LIMIT 1000`, session, agent, session, agent, project, checkout)
	if err != nil {
		return nil, err
	}
	var out []ProbeRow
	for rows.Next() {
		var r ProbeRow
		if err = rows.Scan(&r.ID, &r.EntryID); err != nil {
			break
		}
		out = append(out, r)
	}
	return out, errors.Join(err, rows.Err(), rows.Close())
}

func (h *Hooks) Intent(session, agent string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), h.budget.reader)
	defer cancel()
	var intent string
	err := h.db.QueryRowContext(ctx, `SELECT intent FROM epochs WHERE session_id=? AND agent_id=? ORDER BY epoch DESC LIMIT 1`, session, agent).Scan(&intent)
	if errors.Is(err, sql.ErrNoRows) {
		return "investigating", nil
	}
	return intent, err
}
