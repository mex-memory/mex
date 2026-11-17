package record

import (
	"context"
	"database/sql"
	"time"
)

type JudgeNotice struct{ ID, Text string }

// Exact notice ID and checkout/session kind keys, with bounded text.
func (reader *Reader) JudgeNotice(id, previewKind, updatedKind string) (*JudgeNotice, error) {
	ctx, cancel := context.WithTimeout(context.Background(), reader.budget.reader)
	defer cancel()
	var notice JudgeNotice
	err := reader.db.QueryRowContext(ctx, `SELECT id,CASE WHEN length(CAST(text AS BLOB))<=262144 THEN text ELSE '' END
 FROM notices WHERE id=? AND kind IN (?,?)`, id, previewKind, updatedKind).Scan(&notice.ID, &notice.Text)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &notice, nil
}

func (hooks *Hooks) NoticeShown(id string) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), hooks.budget.reader)
	defer cancel()
	var n int
	err := hooks.db.QueryRowContext(ctx, "SELECT count(*) FROM notices_shown WHERE notice_id=?", id).Scan(&n)
	return n > 0, err
}

// A notice receipt cannot attach to a colliding session id in another host or
// checkout. The normal controller has established the session before display.
func (hooks *Hooks) MarkNotice(id string, session Session, now time.Time) error {
	ctx, cancel := context.WithTimeout(context.Background(), hooks.budget.writer)
	defer cancel()
	return hooks.write(ctx, `INSERT OR IGNORE INTO notices_shown(notice_id,session_id,ts)
 SELECT ?,session_id,? FROM sessions WHERE session_id=? AND agent=? AND project_id=? AND checkout=? AND paused=0`,
		id, now.UTC().Format(time.RFC3339Nano), session.SessionID, session.Agent, session.ProjectID, session.Checkout)
}
