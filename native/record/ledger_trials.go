package record

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"strings"
)

func ValidLedgerTrial(trial string) bool {
	return len(trial) == 32 && !strings.ContainsFunc(trial, func(r rune) bool {
		return (r < '0' || r > '9') && (r < 'a' || r > 'f')
	})
}

// EnrollLedgerTrial assigns only new sessions. A start replay keeps its first
// assignment, and enabling the study cannot enroll an already recorded session.
func (hooks *Hooks) EnrollLedgerTrial(s Session, trial string, holdout bool) (bool, error) {
	if hooks.counterOnly || !ValidLedgerTrial(trial) || !leverForHost(LeverCompaction, s.Agent) ||
		s.SessionID == "" || len(s.SessionID) > 256 || s.ProjectID == "" || s.Checkout == "" {
		return false, errors.New("invalid ledger enrollment")
	}
	ctx, cancel := context.WithTimeout(context.Background(), hooks.budget.writer)
	defer cancel()
	conn, err := hooks.db.Conn(ctx)
	if err != nil {
		return false, err
	}
	defer conn.Close()
	if err := hooks.retryStatement(ctx, conn, "BEGIN IMMEDIATE"); err != nil {
		return false, err
	}
	defer func() { _, _ = conn.ExecContext(context.Background(), "ROLLBACK") }()
	inserted, err := conn.ExecContext(ctx, `INSERT INTO sessions(session_id,agent,project_id,checkout,started_at,last_seen_at)
		VALUES(?,?,?,?,?,?) ON CONFLICT(session_id) DO NOTHING`, s.SessionID, s.Agent, s.ProjectID, s.Checkout, s.StartedAt, s.LastSeenAt)
	if err != nil {
		return false, err
	}
	n, err := inserted.RowsAffected()
	if err != nil {
		return false, err
	}
	if n == 1 {
		if _, err := conn.ExecContext(ctx, `INSERT INTO ledger_trials(session_id,trial,holdout) VALUES(?,?,?)`, s.SessionID, trial, holdout); err != nil {
			return false, err
		}
	} else {
		holdout, err = readLedgerHoldout(ctx, conn, s.SessionID, s.Agent, trial)
		if err != nil {
			return false, err
		}
	}
	_, err = conn.ExecContext(ctx, "COMMIT")
	return holdout && err == nil, err
}

type queryRow interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func readLedgerHoldout(ctx context.Context, db queryRow, session, agent, trial string) (bool, error) {
	var holdout bool
	err := db.QueryRowContext(ctx, `SELECT t.holdout FROM ledger_trials t JOIN sessions s USING(session_id)
		WHERE s.session_id=? AND s.agent=? AND t.trial=?`, session, agent, trial).Scan(&holdout)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return holdout, err
}

// ReadLedgerHoldout checks an opted-in candidate without ever creating a DB.
func ReadLedgerHoldout(file, session, agent, trial string) (bool, error) {
	if _, err := os.Stat(file); err != nil {
		if os.IsNotExist(err) {
			return false, nil
		}
		return false, err
	}
	db, err := openDatabase(file, true)
	if err != nil {
		return false, err
	}
	defer db.Close()
	ctx, cancel := context.WithTimeout(context.Background(), ReaderOperationTimeout)
	defer cancel()
	version, err := schemaVersion(ctx, db)
	if err != nil || version < 13 {
		return false, err
	}
	if version > SchemaVersion {
		return false, futureSchema("hooks.db", version)
	}
	return readLedgerHoldout(ctx, db, session, agent, trial)
}
