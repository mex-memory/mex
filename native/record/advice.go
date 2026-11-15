package record

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
)

// Structured payloads use existing open detail fields; neither database's
// schema nor its single-writer ownership changes.
type AdviceContext struct {
	Version    int    `json:"version"`
	Branch     string `json:"branch"`
	Head       string `json:"head"`
	EntryHash  string `json:"entry_hash"`
	Verdict    string `json:"verdict"`
	InputsHash string `json:"inputs_hash"`
}
type AdviceEffect struct {
	Version  int    `json:"version"`
	Key      string `json:"key"`
	Summary  string `json:"summary"`
	External bool   `json:"external"`
}

func (h *Hooks) CurrentEpoch(session, agent string) (Epoch, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), h.budget.reader)
	defer cancel()
	var e Epoch
	err := h.db.QueryRowContext(ctx, "SELECT epoch,closed FROM epochs WHERE session_id=? AND agent_id=? ORDER BY epoch DESC LIMIT 1", session, agent).Scan(&e.Number, &e.Closed)
	if errors.Is(err, sql.ErrNoRows) {
		return e, false, nil
	}
	return e, err == nil && !e.Closed, err
}

func (h *Hooks) CorrectedAdvice(session, agent, project, checkout string, epoch int) (map[string]bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), h.budget.reader)
	defer cancel()
	rows, err := h.db.QueryContext(ctx, "SELECT entry_id FROM deliveries WHERE session_id=? AND agent_id=? AND epoch=? AND project_id=? AND checkout=? AND moment='correction' LIMIT 20000", session, agent, epoch, project, checkout)
	if err != nil {
		return nil, err
	}
	out := map[string]bool{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			break
		}
		out[id] = true
	}
	return out, errors.Join(err, rows.Err(), rows.Close())
}
func validEffect(detail string) bool {
	var effect AdviceEffect
	return len(detail) <= 2048 && json.Unmarshal([]byte(detail), &effect) == nil && effect.Version == 1 && len(effect.Key) == 64 && effect.Summary != "" && len(effect.Summary) <= 512 && !strings.ContainsAny(effect.Summary, "\x00\r\n")
}

// AdviceEffects reads only this actor's current epoch; corrections never
// include another session's observations. Truncation is explicit.
func (h *Hooks) AdviceEffects(session, agent, project, checkout, entry string) ([]AdviceEffect, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), h.budget.reader)
	defer cancel()
	rows, err := h.db.QueryContext(ctx, `SELECT CASE WHEN length(CAST(f.detail AS BLOB))<=2048 THEN coalesce(f.detail,'') ELSE '' END FROM deliveries d JOIN followups f ON f.delivery_id=d.id
 WHERE d.session_id=? AND d.agent_id=? AND d.project_id=? AND d.checkout=? AND d.entry_id=?
 AND d.epoch=(SELECT max(epoch) FROM epochs WHERE session_id=? AND agent_id=?)
 AND d.action IN ('given','replaced') AND d.moment<>'correction' AND f.kind IN ('edit','command') ORDER BY f.id LIMIT 9`, session, agent, project, checkout, entry, session, agent)
	if err != nil {
		return nil, false, err
	}
	var out []AdviceEffect
	seen := map[string]bool{}
	limited := false
	count := 0
	for rows.Next() {
		count++
		var detail string
		if err = rows.Scan(&detail); err != nil {
			break
		}
		if !validEffect(detail) {
			limited = true
			continue
		}
		var effect AdviceEffect
		_ = json.Unmarshal([]byte(detail), &effect)
		if seen[effect.Key] {
			continue
		}
		seen[effect.Key] = true
		if len(out) == 8 {
			limited = true
			continue
		}
		out = append(out, effect)
	}
	return out, limited || count >= 9, errors.Join(err, rows.Err(), rows.Close())
}
