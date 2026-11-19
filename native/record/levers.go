package record

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

type OutlineGuard struct {
	Outlines  int
	Trips     int
	Off       bool
	OffSince  string
	RearmedAt int64
}

// UpdateLeverState holds the writer lock across the read, decision and write.
// nudge uses independent rows so output-off never reads lever state or counters.
func (h *Hooks) UpdateLeverState(agent, session, subagent string, now time.Time, prune, nudge bool, update func([]byte, *OutlineGuard) ([]byte, error)) error {
	ctx, cancel := context.WithTimeout(context.Background(), h.budget.writer)
	defer cancel()
	c, err := h.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer c.Close()
	if _, err = c.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return err
	}
	defer func() { _, _ = c.ExecContext(context.Background(), "ROLLBACK") }()
	table := "lever_state"
	if nudge {
		table = "compact_nudge_state"
	}
	if prune {
		_, err = c.ExecContext(ctx, "DELETE FROM "+table+" WHERE (agent,session_id,subagent) IN (SELECT agent,session_id,subagent FROM "+table+" WHERE updated_at<? LIMIT 256)", now.Add(-7*24*time.Hour).UTC().Format(time.RFC3339Nano))
		if err != nil {
			return err
		}
	}
	var data string
	err = c.QueryRowContext(ctx, "SELECT state FROM "+table+" WHERE agent=? AND session_id=? AND subagent=?", agent, session, subagent).Scan(&data)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	guard := &OutlineGuard{}
	if !nudge {
		if err = c.QueryRowContext(ctx, "SELECT outlines,trips,off,off_since,rearmed_at FROM outline_guard WHERE id=1").Scan(&guard.Outlines, &guard.Trips, &guard.Off, &guard.OffSince, &guard.RearmedAt); err != nil {
			return err
		}
	}
	next, err := update([]byte(data), guard)
	if err != nil {
		return err
	}
	if len(next) > 4<<20 {
		return fmt.Errorf("session state limit")
	}
	if next != nil {
		_, err = c.ExecContext(ctx, "INSERT INTO "+table+" VALUES(?,?,?,?,?) ON CONFLICT(agent,session_id,subagent) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at", agent, session, subagent, string(next), now.UTC().Format(time.RFC3339Nano))
		if err != nil {
			return err
		}
	}
	if !nudge {
		_, err = c.ExecContext(ctx, "UPDATE outline_guard SET outlines=?,trips=?,off=?,off_since=?,rearmed_at=? WHERE id=1", guard.Outlines, guard.Trips, guard.Off, guard.OffSince, guard.RearmedAt)
		if err != nil {
			return err
		}
	}
	_, err = c.ExecContext(ctx, "COMMIT")
	return err
}

// LeverState reads without taking the writer lock; output-off callers skip it.
func (h *Hooks) LeverState(agent, session, subagent string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), h.budget.reader)
	defer cancel()
	var state string
	err := h.db.QueryRowContext(ctx, "SELECT state FROM lever_state WHERE agent=? AND session_id=? AND subagent=?", agent, session, subagent).Scan(&state)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return []byte(state), err
}
