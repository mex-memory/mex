package record

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// Journal retention: a row goes when it is older than JournalMaxAge or while
// the journal is over JournalCapBytes, oldest first. Rows are kept after the
// filter reads them (journal.consumed is only its cursor), so a later import
// can read past sessions. Session start enforces both limits in bounded steps,
// and an append only checks the running byte total in journal_size; neither
// sums or scans the whole table.
const (
	JournalMaxAge   = 90 * 24 * time.Hour
	JournalCapBytes = 200 << 20
	// journalTrimStep is the most rows one session-start step reads and
	// deletes; journalTrimSteps bounds the steps in one session start. A long
	// backlog is cleared over several session starts.
	journalTrimStep  = 1000
	journalTrimSteps = 4
	// journalTrimEvery is how often, in inserted rows, an append checks the
	// byte total; over the cap it deletes at most journalAppendStep rows.
	journalTrimEvery  = 32
	journalAppendStep = 256
)

// journalCap is JournalCapBytes; tests lower it.
var journalCap int64 = JournalCapBytes

// journalRowBytes is a row's size as journal_size counts it (migration 15).
const journalRowBytes = `length(CAST(text AS BLOB))+length(CAST(session_id AS BLOB))+length(CAST(ts AS BLOB))+16`

// JournalRow is one capture row: what a person typed, a command and its exit
// code, or the repo-relative path a main-agent edit changed. Never agent text,
// file contents or tool output.
type JournalRow struct {
	Kind     string // "typed", "command" or "edit"
	Text     string
	ExitCode *int   // commands only
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

func validJournalRow(r JournalRow) bool {
	if !journalMarks[r.Marks] || strings.ContainsRune(r.Text, 0) {
		return false
	}
	switch r.Kind {
	case "typed", "command":
		return true
	case "edit":
		return r.Text != "" && r.ExitCode == nil
	}
	return false
}

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
		if !validJournalRow(r) {
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
		if _, _, err = trimJournalStep(ctx, conn, time.Time{}, journalCap, journalAppendStep); err != nil {
			return err
		}
	}
	_, err = conn.ExecContext(ctx, "COMMIT")
	return err
}

// trimJournalStep deletes the oldest rows that are older than cutoff (zero:
// no age limit) or that keep the journal over capBytes, reading at most limit
// rows. Ids grow with time, so expired rows are a prefix. more reports a full
// step that may have left more to delete.
func trimJournalStep(ctx context.Context, conn *sql.Conn, cutoff time.Time, capBytes int64, limit int) (deleted int, more bool, err error) {
	var total int64
	if err = conn.QueryRowContext(ctx, `SELECT bytes FROM journal_size WHERE id=1`).Scan(&total); err != nil {
		return 0, false, err
	}
	if cutoff.IsZero() && total <= capBytes {
		return 0, false, nil
	}
	rows, err := conn.QueryContext(ctx, `SELECT id,ts,`+journalRowBytes+` FROM journal ORDER BY id LIMIT ?`, limit)
	if err != nil {
		return 0, false, err
	}
	var cut int64
	kept := false
	for rows.Next() {
		var id, size int64
		var ts string
		if err = rows.Scan(&id, &ts, &size); err != nil {
			rows.Close()
			return 0, false, err
		}
		if total <= capBytes && !expired(ts, cutoff) {
			kept = true
			break
		}
		cut, total = id, total-size
		deleted++
	}
	rows.Close()
	if err = rows.Err(); err != nil || cut == 0 {
		return 0, false, err
	}
	if _, err = conn.ExecContext(ctx, `DELETE FROM journal WHERE id <= ?`, cut); err != nil {
		return 0, false, err
	}
	return deleted, !kept && deleted == limit, nil
}

// expired reports a row timestamp before cutoff. An unreadable one is kept.
func expired(ts string, cutoff time.Time) bool {
	if cutoff.IsZero() {
		return false
	}
	at, err := time.Parse(time.RFC3339Nano, ts)
	return err == nil && at.Before(cutoff)
}

// TrimJournal enforces retention at session start: at most journalTrimSteps
// steps, each its own short transaction so other hooks wait at most one step.
// It reports whether rows may be left for the next session start.
func (hooks *Hooks) TrimJournal(now time.Time) (bool, error) {
	if hooks.counterOnly {
		return false, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), hooks.budget.writer)
	defer cancel()
	conn, err := hooks.db.Conn(ctx)
	if err != nil {
		return false, err
	}
	defer conn.Close()
	cutoff := now.Add(-JournalMaxAge)
	for step := 0; step < journalTrimSteps; step++ {
		more, err := hooks.trimJournalOnce(ctx, conn, cutoff)
		if err != nil || !more {
			return more, err
		}
	}
	return true, nil
}

func (hooks *Hooks) trimJournalOnce(ctx context.Context, conn *sql.Conn, cutoff time.Time) (bool, error) {
	if err := hooks.retryStatement(ctx, conn, "BEGIN IMMEDIATE"); err != nil {
		return false, err
	}
	defer func() { _, _ = conn.ExecContext(context.Background(), "ROLLBACK") }()
	_, more, err := trimJournalStep(ctx, conn, cutoff, journalCap, journalTrimStep)
	if err != nil {
		return false, err
	}
	_, err = conn.ExecContext(ctx, "COMMIT")
	return more, err
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
