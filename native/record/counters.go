package record

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// OpenHookCounters applies the usage budget to opening and migration as well as
// writes. Contention must skip measurement rather than delay an agent hook.
func OpenHookCounters(location Location) (*Hooks, error) {
	limits := budget{writerBusy: time.Millisecond, writer: 10 * time.Millisecond, reader: ReaderOperationTimeout}
	return openHookDatabase(location, limits, true)
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
	// Counter-only pools open and restore every connection with this policy.
	// Ordinary session writers still need the tighter policy for a usage call.
	if !hooks.counterOnly {
		if _, err := conn.ExecContext(ctx, "PRAGMA busy_timeout=1"); err != nil {
			return err
		}
	}
	values := make([]string, 0, len(names))
	args := make([]any, 0, 2*len(names))
	for _, name := range names {
		values = append(values, "(?,?,1)")
		args = append(args, day, "agent:"+agent+":"+name)
	}
	// One SQLite statement is atomic, including a constraint/trigger failure.
	// Avoid a separate BEGIN, statement per counter, and COMMIT for every hook.
	_, err = conn.ExecContext(ctx, "INSERT INTO main.counters_go(day,name,value) VALUES"+strings.Join(values, ",")+
		" ON CONFLICT(day,name) DO UPDATE SET value=min(2147483647,value+1)", args...)
	return err
}
