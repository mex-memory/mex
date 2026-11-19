package record

import (
	"context"
	"database/sql"
	"errors"
)

// Shares of the epoch. Critical failures/corrections retain their explicit
// exemption: they may exceed the reserve, but cannot consume another lane.
func LaneLimit(lane string, budget int) int {
	switch lane {
	case "critical":
		return budget * 20 / 100
	case "cards":
		return budget * 40 / 100
	case "prompt":
		return budget * 15 / 100
	case "brief":
		return budget * 15 / 100
	case "main":
		return budget - budget*20/100 - budget*40/100 - budget*15/100 - budget*15/100
	}
	return budget
}

func LaneFor(c DeliveryCandidate) string {
	if c.Reserved || c.Exempt || c.Correction {
		return "critical"
	}
	switch c.Surface {
	case "search-span", "graph-card":
		return "cards"
	case "prompt", "prompt-anchor":
		return "prompt"
	case "start-brief", "start-brief-working-set", "recovery", "carry":
		return "brief"
	}
	return "main"
}

func laneUsage(ctx context.Context, c *sql.Conn, req DeliveryRequest, epoch int) (map[string]int, error) {
	used := map[string]int{}
	rows, err := c.QueryContext(ctx, `SELECT lane,sum(tokens) FROM deliveries WHERE session_id=? AND agent_id=? AND epoch=? AND action IN ('given','replaced','shadow') GROUP BY lane`, req.Session.SessionID, req.AgentID, epoch)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var lane string
		var tokens int
		if err = rows.Scan(&lane, &tokens); err != nil {
			return nil, err
		}
		used[lane] = tokens
	}
	return used, rows.Err()
}

func recordLaneOffer(ctx context.Context, c *sql.Conn, req DeliveryRequest, epoch int, id, lane string, tokens int, held bool) error {
	_, err := c.ExecContext(ctx, `INSERT INTO lane_offers VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id,agent_id,epoch,project_id,checkout,entry_id,lane) DO UPDATE SET tokens=max(tokens,excluded.tokens),budget_held=max(budget_held,excluded.budget_held)`, req.Session.SessionID, req.AgentID, epoch, req.Session.ProjectID, req.Session.Checkout, id, lane, tokens, held)
	return err
}

// LaneRoom is only a shaping hint. Admission rechecks every debit under the
// writer lock, so concurrent hook processes cannot overfill a lane.
func (h *Hooks) LaneRoom(session, agent, lane string) (int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), h.budget.reader)
	defer cancel()
	var budget, used int
	err := h.db.QueryRowContext(ctx, `SELECT e.budget,coalesce((SELECT sum(d.tokens) FROM deliveries d WHERE d.session_id=e.session_id AND d.agent_id=e.agent_id AND d.epoch=e.epoch AND d.lane=? AND d.action IN ('given','replaced','shadow')),0) FROM epochs e WHERE e.session_id=? AND e.agent_id=? ORDER BY e.epoch DESC LIMIT 1`, lane, session, agent).Scan(&budget, &used)
	if errors.Is(err, sql.ErrNoRows) {
		return LaneLimit(lane, 2000), nil
	}
	if err != nil {
		return 0, err
	}
	return max(0, LaneLimit(lane, budget)-used), nil
}

type LaneContention struct {
	Session  string `json:"session"`
	Agent    string `json:"agent"`
	Epoch    int    `json:"epoch"`
	Lane     string `json:"lane"`
	Capacity int    `json:"capacity"`
	Offered  int    `json:"offeredTokens"`
	Admitted int    `json:"admittedTokens"`
	Held     int    `json:"budgetHeldItems"`
}

func readLaneContention(ctx context.Context, db *sql.DB, project, checkout string) ([]LaneContention, error) {
	rows, err := db.QueryContext(ctx, `SELECT o.session_id,o.agent_id,o.epoch,o.lane,e.budget,sum(o.tokens),sum(o.budget_held),coalesce((SELECT sum(d.tokens) FROM deliveries d WHERE d.session_id=o.session_id AND d.agent_id=o.agent_id AND d.epoch=o.epoch AND d.lane=o.lane AND d.action IN ('given','replaced','shadow')),0) FROM lane_offers o JOIN epochs e ON e.session_id=o.session_id AND e.agent_id=o.agent_id AND e.epoch=o.epoch WHERE o.project_id=? AND (?='' OR o.checkout=?) GROUP BY o.session_id,o.agent_id,o.epoch,o.lane,e.budget ORDER BY o.session_id,o.agent_id,o.epoch,o.lane LIMIT 5000`, project, checkout, checkout)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []LaneContention
	for rows.Next() {
		var l LaneContention
		var budget int
		if err = rows.Scan(&l.Session, &l.Agent, &l.Epoch, &l.Lane, &budget, &l.Offered, &l.Held, &l.Admitted); err != nil {
			return nil, err
		}
		l.Capacity = LaneLimit(l.Lane, budget)
		out = append(out, l)
	}
	return out, rows.Err()
}
