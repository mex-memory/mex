package record

import (
	"context"
	"fmt"
	"time"
)

// OpenHookCounters applies the usage budget to opening and migration as well as
// writes. Contention must skip measurement rather than delay an agent hook.
func OpenHookCounters(location Location) (*Hooks, error) {
	return openHooks(location, 1, 10*time.Millisecond)
}

// RecordHookUsage writes only bounded usage counts. No payload, path or session ID
// enters these rows. The small deadline is deliberately below the normal writer budget.
func (hooks *Hooks) RecordHookUsage(day, agent string, sessionStart, failed bool, elapsedMS int64) error {
	if _, err := time.Parse("2006-01-02", day); err != nil {
		return err
	}
	if agent != "claude-code" && agent != "codex" {
		return fmt.Errorf("unknown telemetry agent")
	}
	if elapsedMS < 0 {
		return fmt.Errorf("negative hook duration")
	}
	bucket := 5
	for i, upper := range []int64{0, 1, 5, 20, 100} {
		if elapsedMS <= upper {
			bucket = i
			break
		}
	}
	names := []string{"hook.calls", fmt.Sprintf("hook.ms.%d", bucket)}
	if sessionStart {
		names = append(names, "sessions")
	}
	if failed {
		names = append(names, "hook.errors")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	conn, err := hooks.db.Conn(ctx)
	if err != nil {
		return err
	}
	defer conn.Close()
	if _, err := conn.ExecContext(ctx, "PRAGMA busy_timeout=1"); err != nil {
		return err
	}
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, name := range names {
		if _, err := tx.ExecContext(ctx, `INSERT INTO counters_go(day,name,value) VALUES(?,?,1)
    ON CONFLICT(day,name) DO UPDATE SET value=min(2147483647,value+1)`, day, "agent:"+agent+":"+name); err != nil {
			return err
		}
	}
	return tx.Commit()
}
