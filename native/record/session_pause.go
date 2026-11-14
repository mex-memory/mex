package record

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// SetSessionPaused serializes the durable session choice and its small hook
// mirror. Only Go writes either. publish must be bounded and idempotent; it is
// called with the previous choice on failure before releasing the writer lock.
func (hooks *Hooks) SetSessionPaused(session Session, publish func(bool) error) error {
	if publish == nil {
		return fmt.Errorf("pause publisher is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), hooks.budget.writer)
	defer cancel()
	conn, err := hooks.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	defer func() { _, _ = conn.ExecContext(context.Background(), "ROLLBACK") }()
	var oldAgent string
	var previous bool
	err = conn.QueryRowContext(ctx, "SELECT agent,paused FROM sessions WHERE session_id=?", session.SessionID).Scan(&oldAgent, &previous)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if err == nil && oldAgent != session.Agent {
		return fmt.Errorf("session belongs to another agent")
	}
	stamp := time.Now().UTC().Format(time.RFC3339Nano)
	if _, err = conn.ExecContext(ctx, `INSERT INTO sessions(session_id,agent,project_id,checkout,started_at,last_seen_at,paused)
VALUES(?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET last_seen_at=excluded.last_seen_at,paused=excluded.paused`,
		session.SessionID, session.Agent, session.ProjectID, session.Checkout, stamp, stamp, session.Paused); err != nil {
		return err
	}
	if err = publish(session.Paused); err == nil {
		_, err = conn.ExecContext(ctx, "COMMIT")
	}
	if err != nil {
		_ = publish(previous)
	}
	return err
}
