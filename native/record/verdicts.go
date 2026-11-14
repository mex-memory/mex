package record

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

// Verdict is one entry's cached verdict in one checkout.
type Verdict struct {
	EntryID    string `json:"entry_id"`
	Verdict    string `json:"verdict"`
	InputsHash string `json:"inputs_hash"`
	CheckedAt  string `json:"checked_at"`
}

// verdictRows bounds one INSERT so a statement stays small.
const verdictRows = 100

// PutVerdicts stores verdicts for a checkout, replacing earlier ones.
func (hooks *Hooks) PutVerdicts(projectID, checkout string, verdicts []Verdict) error {
	if hooks.counterOnly {
		return errors.New("counter handle can't write verdicts")
	}
	for start := 0; start < len(verdicts); start += verdictRows {
		chunk := verdicts[start:min(len(verdicts), start+verdictRows)]
		values := make([]string, len(chunk))
		args := make([]any, 0, len(chunk)*6)
		for i, v := range chunk {
			values[i] = "(?,?,?,?,?,?)"
			args = append(args, projectID, checkout, v.EntryID, v.Verdict, v.InputsHash, v.CheckedAt)
		}
		ctx, cancel := context.WithTimeout(context.Background(), hooks.budget.writer)
		err := hooks.write(ctx, `INSERT INTO verdicts(project_id,checkout,entry_id,verdict,inputs_hash,checked_at) VALUES `+strings.Join(values, ",")+
			` ON CONFLICT(project_id,checkout,entry_id) DO UPDATE SET verdict=excluded.verdict,inputs_hash=excluded.inputs_hash,checked_at=excluded.checked_at`, args...)
		cancel()
		if err != nil {
			return err
		}
	}
	return nil
}

// DropVerdicts removes a checkout's verdicts for entries that no longer exist.
func (hooks *Hooks) DropVerdicts(projectID, checkout string, keep []string) error {
	ctx, cancel := context.WithTimeout(context.Background(), hooks.budget.writer)
	defer cancel()
	if len(keep) == 0 {
		return hooks.write(ctx, `DELETE FROM verdicts WHERE project_id=? AND checkout=?`, projectID, checkout)
	}
	marks := strings.TrimSuffix(strings.Repeat("?,", len(keep)), ",")
	args := []any{projectID, checkout}
	for _, id := range keep {
		args = append(args, id)
	}
	return hooks.write(ctx, `DELETE FROM verdicts WHERE project_id=? AND checkout=? AND entry_id NOT IN (`+marks+`)`, args...)
}

// Verdicts reads every cached verdict of a checkout, by entry id.
func (hooks *Hooks) Verdicts(projectID, checkout string) (map[string]Verdict, error) {
	ctx, cancel := context.WithTimeout(context.Background(), hooks.budget.reader)
	defer cancel()
	rows, err := hooks.db.QueryContext(ctx, `SELECT entry_id,verdict,inputs_hash,checked_at FROM verdicts WHERE project_id=? AND checkout=?`, projectID, checkout)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]Verdict{}
	for rows.Next() {
		var v Verdict
		if err := rows.Scan(&v.EntryID, &v.Verdict, &v.InputsHash, &v.CheckedAt); err != nil {
			return nil, err
		}
		out[v.EntryID] = v
	}
	return out, rows.Err()
}

// VerdictOf reads one entry's cached verdict: the delivery gate's read.
func (hooks *Hooks) VerdictOf(projectID, checkout, entryID string) (Verdict, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), hooks.budget.reader)
	defer cancel()
	v := Verdict{EntryID: entryID}
	err := hooks.db.QueryRowContext(ctx, `SELECT verdict,inputs_hash,checked_at FROM verdicts WHERE project_id=? AND checkout=? AND entry_id=?`,
		projectID, checkout, entryID).Scan(&v.Verdict, &v.InputsHash, &v.CheckedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Verdict{}, false, nil
	}
	if err != nil {
		return Verdict{}, false, err
	}
	return v, true, nil
}
