package record

import (
	"context"
	"database/sql"
	"errors"
)

// FollowupObservation contains no prompt, command or code text. Observations
// attach to a prior holdback in this same epoch and checkout, at most once
// per receipt/kind. The controller calls this only on an existing DB path.
type FollowupObservation struct{ EntryID, Kind, ReceiptID, Detail string }

func observationKind(s string) bool {
	switch s {
	case "missed", "command", "failure":
		return true
	}
	return false
}

func observeHoldbacks(ctx context.Context, c *sql.Conn, req DeliveryRequest, epoch int, stamp string) error {
	for _, o := range req.Observations {
		if !observationKind(o.Kind) || o.EntryID == "" || len(o.EntryID) > 128 || o.ReceiptID == "" || len(o.ReceiptID) > 128 {
			return errors.New("invalid holdback observation")
		}
		_, err := c.ExecContext(ctx, `INSERT INTO followups(delivery_id,ts,kind)
 SELECT d.id,?,? FROM deliveries d
 WHERE d.session_id=? AND d.agent_id=? AND d.epoch=? AND d.project_id=? AND d.checkout=?
 AND d.entry_id=? AND d.id=? AND d.action IN ('held-back','withheld') AND d.moment<>'correction'
 AND NOT EXISTS(SELECT 1 FROM followups f WHERE f.delivery_id=d.id AND f.kind=?)
 LIMIT 2`, stamp, o.Kind, req.Session.SessionID, req.AgentID, epoch, req.Session.ProjectID, req.Session.Checkout, o.EntryID, o.ReceiptID, o.Kind)
		if err != nil {
			return err
		}
	}
	return nil
}

func closeHoldbacks(ctx context.Context, c *sql.Conn, session, agent string, epoch int, stamp string) error {
	// At most 1000 receipts per call. If a very large epoch exceeds the bound,
	// absent followups mean "never observed", not an assertion about behaviour.
	_, err := c.ExecContext(ctx, `INSERT INTO followups(delivery_id,ts,kind)
 SELECT d.id,?,'nothing' FROM deliveries d
 WHERE d.session_id=? AND d.agent_id=? AND d.epoch=?
 AND d.action IN ('held-back','withheld') AND d.moment<>'correction'
 AND NOT EXISTS(SELECT 1 FROM followups f WHERE f.delivery_id=d.id) LIMIT 1000`, stamp, session, agent, epoch)
	return err
}

func deliveredLater(ctx context.Context, c *sql.Conn, req DeliveryRequest, epoch int, id, stamp string) error {
	_, err := c.ExecContext(ctx, `INSERT INTO followups(delivery_id,ts,kind)
 SELECT d.id,?,'delivered-later' FROM deliveries d
 WHERE d.session_id=? AND d.agent_id=? AND d.epoch=? AND d.project_id=? AND d.checkout=?
 AND d.entry_id=? AND d.action IN ('held-back','withheld') AND d.moment<>'correction'
 AND NOT EXISTS(SELECT 1 FROM followups f WHERE f.delivery_id=d.id AND f.kind='delivered-later') LIMIT 2`, stamp, req.Session.SessionID, req.AgentID, epoch, req.Session.ProjectID, req.Session.Checkout, id)
	return err
}

// HoldbackEntries returns at most 1000 distinct ids from the current epoch.
// It does not initialize an epoch or create a database.
type HoldbackRow struct{ ID, EntryID, Detail string }

func (hooks *Hooks) HoldbackEntries(session, agent, project, checkout string) ([]HoldbackRow, error) {
	ctx, cancel := context.WithTimeout(context.Background(), hooks.budget.reader)
	defer cancel()
	rows, err := hooks.db.QueryContext(ctx, `SELECT id,entry_id,detail FROM deliveries WHERE session_id=? AND agent_id=?
 AND epoch=(SELECT max(epoch) FROM epochs WHERE session_id=? AND agent_id=?)
 AND project_id=? AND checkout=? AND action IN ('held-back','withheld') AND moment<>'correction'
 ORDER BY entry_id,id LIMIT 1000`, session, agent, session, agent, project, checkout)
	if err != nil {
		return nil, err
	}
	var ids []HoldbackRow
	for rows.Next() {
		var row HoldbackRow
		if err = rows.Scan(&row.ID, &row.EntryID, &row.Detail); err != nil {
			break
		}
		ids = append(ids, row)
	}
	return ids, errors.Join(err, rows.Err(), rows.Close())
}

// MissedCounts feeds risk only from past delivered entries, never heldbacks.
// Recent followups are bounded; no text leaves this projection.
func (hooks *Hooks) MissedCounts(project, checkout string) (map[string]int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), hooks.budget.reader)
	defer cancel()
	rows, err := hooks.db.QueryContext(ctx, `SELECT d.entry_id FROM
 (SELECT delivery_id FROM followups WHERE kind='missed' ORDER BY id DESC LIMIT 5000) f
 JOIN deliveries d ON d.id=f.delivery_id WHERE d.project_id=? AND d.checkout=? AND d.action IN ('given','replaced')`, project, checkout)
	if err != nil {
		return nil, err
	}
	out := map[string]int{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			break
		}
		out[id]++
	}
	return out, errors.Join(err, rows.Err(), rows.Close())
}
