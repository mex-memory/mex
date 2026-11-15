package record

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

// JournalCapBytes bounds the text the capture journal keeps (plan sheet 21:
// a 5 MB cap). Past it, the oldest rows go first.
const JournalCapBytes = 5 << 20

// journalTrimEvery is how often, in inserted rows, an append also enforces the
// cap. Rows are bounded by the caller, so between checks the journal can pass
// the cap by at most this many rows.
const journalTrimEvery = 32

// JournalRow is one capture row: what a person typed, or a command and its
// exit code. Never agent text, file contents or tool output.
type JournalRow struct {
	Kind     string // "typed" or "command"
	Text     string
	ExitCode *int
	Marks    string // "", "pasted", "scripted" or "pasted,scripted"
}

// JournalEntry is a stored row.
type JournalEntry struct {
	ID        int64
	SessionID string
	TS        string
	JournalRow
}

var journalMarks = map[string]bool{"": true, "pasted": true, "scripted": true, "pasted,scripted": true}

// AppendJournal adds rows for a session in one transaction. The session row is
// created when missing and otherwise left as it is (a pause stays a pause).
func (hooks *Hooks) AppendJournal(session Session, ts string, rows []JournalRow) error {
	if hooks.counterOnly || len(rows) == 0 {
		return nil
	}
	if session.SessionID == "" || len(session.SessionID) > 512 {
		return errors.New("invalid journal session")
	}
	for _, r := range rows {
		if (r.Kind != "typed" && r.Kind != "command") || !journalMarks[r.Marks] || strings.ContainsRune(r.Text, 0) {
			return errors.New("invalid journal row")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), hooks.budget.writer)
	defer cancel()
	conn, err := hooks.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if err = hooks.retryStatement(ctx, conn, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	defer func() { _, _ = conn.ExecContext(context.Background(), "ROLLBACK") }()
	if _, err = conn.ExecContext(ctx, `INSERT OR IGNORE INTO sessions(session_id,agent,project_id,checkout,started_at,last_seen_at,paused) VALUES(?,?,?,?,?,?,0)`,
		session.SessionID, session.Agent, session.ProjectID, session.Checkout, ts, ts); err != nil {
		return err
	}
	var last int64
	for _, r := range rows {
		var code any
		if r.ExitCode != nil {
			code = *r.ExitCode
		}
		res, err := conn.ExecContext(ctx, `INSERT INTO journal(session_id,ts,kind,text,exit_code,marks) VALUES(?,?,?,?,?,?)`, session.SessionID, ts, r.Kind, r.Text, code, r.Marks)
		if err != nil {
			return err
		}
		if last, err = res.LastInsertId(); err != nil {
			return err
		}
	}
	if last/journalTrimEvery != (last-int64(len(rows)))/journalTrimEvery {
		if err = trimJournal(ctx, conn, JournalCapBytes); err != nil {
			return err
		}
	}
	_, err = conn.ExecContext(ctx, "COMMIT")
	return err
}

// trimJournal deletes the oldest rows until the text kept fits the cap.
func trimJournal(ctx context.Context, conn *sql.Conn, capBytes int64) error {
	var cut sql.NullInt64
	err := conn.QueryRowContext(ctx, `SELECT max(id) FROM (SELECT id, sum(length(CAST(text AS BLOB))) OVER (ORDER BY id DESC) AS tail FROM journal) WHERE tail > ?`, capBytes).Scan(&cut)
	if err != nil || !cut.Valid {
		return err
	}
	_, err = conn.ExecContext(ctx, `DELETE FROM journal WHERE id <= ?`, cut.Int64)
	return err
}

// TrimJournal enforces the cap now. Session start calls it once.
func (hooks *Hooks) TrimJournal() error {
	if hooks.counterOnly {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), hooks.budget.writer)
	defer cancel()
	conn, err := hooks.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if err = hooks.retryStatement(ctx, conn, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	defer func() { _, _ = conn.ExecContext(context.Background(), "ROLLBACK") }()
	if err = trimJournal(ctx, conn, JournalCapBytes); err != nil {
		return err
	}
	_, err = conn.ExecContext(ctx, "COMMIT")
	return err
}

// PruneJournal deletes a project's rows up to the last ID a capture batch
// consumed (record.db settings, key journal.consumed). Deletion after each
// batch: the journal never keeps what the filter already read.
func (hooks *Hooks) PruneJournal(projectID string, consumed int64) error {
	if hooks.counterOnly || projectID == "" || consumed <= 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), hooks.budget.writer)
	defer cancel()
	return hooks.write(ctx, `DELETE FROM journal WHERE id <= ? AND session_id IN (SELECT session_id FROM sessions WHERE project_id = ?)`, consumed, projectID)
}

// JournalRows reads a session's rows in order, at most limit of them.
func (hooks *Hooks) JournalRows(sessionID string, limit int) ([]JournalEntry, error) {
	ctx, cancel := context.WithTimeout(context.Background(), hooks.budget.reader)
	defer cancel()
	rows, err := hooks.db.QueryContext(ctx, `SELECT id,session_id,ts,kind,text,exit_code,marks FROM journal WHERE session_id=? ORDER BY id LIMIT ?`, sessionID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []JournalEntry
	for rows.Next() {
		var e JournalEntry
		var code sql.NullInt64
		if err := rows.Scan(&e.ID, &e.SessionID, &e.TS, &e.Kind, &e.Text, &code, &e.Marks); err != nil {
			return nil, err
		}
		if code.Valid {
			c := int(code.Int64)
			e.ExitCode = &c
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// ShowOnce claims a notice for a session. It reports true only for the first
// claim of that notice ID, across sessions and agents.
func (hooks *Hooks) ShowOnce(session Session, noticeID, ts string) (bool, error) {
	if hooks.counterOnly || noticeID == "" || len(noticeID) > 256 {
		return false, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), hooks.budget.writer)
	defer cancel()
	conn, err := hooks.db.Conn(ctx)
	if err != nil {
		return false, err
	}
	defer conn.Close()
	if err = hooks.retryStatement(ctx, conn, "BEGIN IMMEDIATE"); err != nil {
		return false, err
	}
	defer func() { _, _ = conn.ExecContext(context.Background(), "ROLLBACK") }()
	if _, err = conn.ExecContext(ctx, `INSERT OR IGNORE INTO sessions(session_id,agent,project_id,checkout,started_at,last_seen_at,paused) VALUES(?,?,?,?,?,?,0)`,
		session.SessionID, session.Agent, session.ProjectID, session.Checkout, ts, ts); err != nil {
		return false, err
	}
	res, err := conn.ExecContext(ctx, `INSERT OR IGNORE INTO notices_shown(notice_id,session_id,ts) VALUES(?,?,?)`, noticeID, session.SessionID, ts)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	if _, err = conn.ExecContext(ctx, "COMMIT"); err != nil {
		return false, err
	}
	return n == 1, nil
}

// Delivered reports whether an entry was given in a session.
func (hooks *Hooks) Delivered(sessionID, entryID string) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), hooks.budget.reader)
	defer cancel()
	var one int
	err := hooks.db.QueryRowContext(ctx, `SELECT 1 FROM deliveries WHERE session_id=? AND entry_id=? AND action='given' LIMIT 1`, sessionID, entryID).Scan(&one)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return err == nil, err
}
