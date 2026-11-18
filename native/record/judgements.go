package record

import (
	"context"
	"database/sql"
)

// Judgement checks the committed journal row behind a derived model attestation.
func (reader *Reader) Judgement(project, id, inputs string) (string, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), reader.budget.reader)
	defer cancel()
	var result string
	err := reader.db.QueryRowContext(ctx, "SELECT result FROM judgements WHERE project_id=? AND entry_id=? AND inputs_hash=?", project, id, inputs).Scan(&result)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	return result, err == nil, err
}
