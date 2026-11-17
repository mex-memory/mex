package record

import (
	"context"
	"database/sql"
	"errors"
)

// Offers are unique per canonical entry and checkout in an epoch. The writer
// lock makes the rollup and its claim one transaction, including racing hooks.
func recordEpochOffer(ctx context.Context, c *sql.Conn, req DeliveryRequest, e *Epoch, id string, tokens int, held bool) error {
	var previous, previousHeld int
	err := c.QueryRowContext(ctx, `SELECT tokens,budget_held FROM epoch_offers WHERE session_id=? AND agent_id=? AND epoch=? AND project_id=? AND checkout=? AND entry_id=?`, req.Session.SessionID, req.AgentID, e.Number, req.Session.ProjectID, req.Session.Checkout, id).Scan(&previous, &previousHeld)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if tokens < previous {
		tokens = previous
	}
	heldValue := previousHeld
	if held {
		heldValue = 1
	}
	_, err = c.ExecContext(ctx, `INSERT INTO epoch_offers VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(session_id,agent_id,epoch,project_id,checkout,entry_id) DO UPDATE SET tokens=max(tokens,excluded.tokens),budget_held=max(budget_held,excluded.budget_held)`, req.Session.SessionID, req.AgentID, e.Number, req.Session.ProjectID, req.Session.Checkout, id, tokens, heldValue)
	if err == nil {
		e.CandidateTokens += tokens - previous
		e.BudgetHeld += heldValue - previousHeld
	}
	return err
}

type ContentionReport struct {
	Epochs          int      `json:"epochs"`
	UnknownEpochs   int      `json:"unknownEpochs"`
	Contested       int      `json:"contestedEpochs"`
	Share           *float64 `json:"contestedShare"`
	CandidateTokens int      `json:"candidateTokens"`
	AdmittedTokens  int      `json:"admittedTokens"`
	BudgetHeld      int      `json:"budgetHeldItems"`
}

func contentionSummary(ctx context.Context, q interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}, project, checkout string) (ContentionReport, error) {
	var r ContentionReport
	rows, err := q.QueryContext(ctx, `SELECT e.contention_measured,count(*),coalesce(sum(CASE WHEN e.candidate_tokens>e.budget THEN 1 ELSE 0 END),0),coalesce(sum(e.candidate_tokens),0),coalesce(sum(e.admitted_tokens),0),coalesce(sum(e.budget_held),0) FROM epochs e JOIN sessions s ON s.session_id=e.session_id WHERE s.project_id=? AND (?='' OR s.checkout=?) GROUP BY e.contention_measured`, project, checkout, checkout)
	if err != nil {
		return r, err
	}
	for rows.Next() {
		var measured, epochs, contested, offered, admitted, held int
		if err = rows.Scan(&measured, &epochs, &contested, &offered, &admitted, &held); err != nil {
			break
		}
		if measured == 0 {
			r.UnknownEpochs += epochs
			continue
		}
		r.Epochs += epochs
		r.Contested += contested
		r.CandidateTokens += offered
		r.AdmittedTokens += admitted
		r.BudgetHeld += held
	}
	err = errors.Join(err, rows.Err(), rows.Close())
	if r.Epochs > 0 {
		share := float64(r.Contested) / float64(r.Epochs)
		r.Share = &share
	}
	return r, err
}
