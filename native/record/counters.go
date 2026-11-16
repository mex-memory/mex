package record

import (
	"context"
	"fmt"
	"sort"
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
	return hooks.recordHookUsage(day, agent, sessionStart, failed, elapsedMS, 10*time.Millisecond)
}

// Correctness tests can exercise the same atomic operation with a fixture
// deadline, independently of the exported best-effort production call.
func (hooks *Hooks) recordHookUsage(day, agent string, sessionStart, failed bool, elapsedMS int64, timeout time.Duration) error {
	names, err := usageNames(day, agent, sessionStart, failed, elapsedMS)
	if err != nil {
		return err
	}
	counts := map[counterKey]int{}
	for _, name := range names {
		counts[counterKey{day, name}]++
	}
	return hooks.addCounts(counts, timeout)
}

// telemetryAgent lists the agents with a hook profile, as named in the usage
// report's agent catalog (src/telemetry/report-schema.ts).
func telemetryAgent(agent string) bool {
	switch agent {
	case "claude-code", "codex", "copilot", "cursor", "opencode", "antigravity", "gemini", "devin", "kiro":
		return true
	}
	return false
}

// counterKey is one row of counters_go.
type counterKey struct{ day, name string }

// usageNames lists the counters one hook call adds to.
func usageNames(day, agent string, sessionStart, failed bool, elapsedMS int64) ([]string, error) {
	if _, err := time.Parse("2006-01-02", day); err != nil {
		return nil, err
	}
	if !telemetryAgent(agent) {
		return nil, fmt.Errorf("unknown telemetry agent")
	}
	if elapsedMS < 0 {
		return nil, fmt.Errorf("negative hook duration")
	}
	bucket := 5
	for i, upper := range []int64{0, 1, 5, 20, 100} {
		if elapsedMS <= upper {
			bucket = i
			break
		}
	}
	short := []string{"hook.calls", fmt.Sprintf("hook.ms.%d", bucket)}
	if sessionStart {
		short = append(short, "sessions")
	}
	if failed {
		short = append(short, "hook.errors")
	}
	names := make([]string, len(short))
	for i, name := range short {
		names[i] = "agent:" + agent + ":" + name
	}
	return names, nil
}

// addCounts adds every count in one transaction, within the deadline.
func (hooks *Hooks) addCounts(counts map[counterKey]int, timeout time.Duration) error {
	if len(counts) == 0 {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
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
	keys := make([]counterKey, 0, len(counts))
	for key := range counts {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(i, j int) bool {
		if keys[i].day != keys[j].day {
			return keys[i].day < keys[j].day
		}
		return keys[i].name < keys[j].name
	})
	values := make([]string, 0, len(keys))
	args := make([]any, 0, 3*len(keys))
	for _, key := range keys {
		values = append(values, "(?,?,?)")
		args = append(args, key.day, key.name, counts[key])
	}
	// ExecContext on an autocommit statement can report cancellation after
	// SQLite committed. Deferring that batch would count it twice. An explicit
	// transaction rolls a cancelled statement back; database/sql's Commit owns
	// the commit/cancellation boundary and returns the actual commit result.
	tx, err := conn.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, "INSERT INTO main.counters_go(day,name,value) VALUES"+strings.Join(values, ",")+
		" ON CONFLICT(day,name) DO UPDATE SET value=min(2147483647,value+excluded.value)", args...)
	if err != nil {
		return err
	}
	return tx.Commit()
}
