package record

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"testing"
	"time"
)

// Keep the portable process timing gate authoritative. This breakdown makes
// filesystem/SQLite regressions diagnosable on the actual CI operating system.
func TestCounterCycleTimingBreakdown(t *testing.T) {
	options := LocationOptions{Home: filepath.Join(t.TempDir(), ".mex"), Cache: t.TempDir()}
	location, err := ResolveLocation(options)
	if err != nil {
		t.Fatal(err)
	}
	initial, err := openHooks(location, testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer initial.Close()
	options.ReadOnly = true
	const samples = 100
	stages := [4][]time.Duration{}
	var successful, openDeadlines, writeDeadlines int
	// A failed open/write is useful timing evidence too. Cleanup runs after
	// Fatal, so retain completed stages instead of losing the whole profile.
	t.Cleanup(func() {
		t.Logf("counter cycle outcomes: successful=%d open_deadlines=%d write_deadlines=%d", successful, openDeadlines, writeDeadlines)
		for index, name := range []string{"resolve", "open", "increment", "close"} {
			values := stages[index]
			count := len(values)
			if count == 0 {
				t.Logf("counter cycle %s: samples=0", name)
				continue
			}
			sort.Slice(values, func(i, j int) bool { return values[i] < values[j] })
			t.Logf("counter cycle %s: samples=%d p50=%.3fms p95=%.3fms max=%.3fms", name, count,
				float64(values[count/2])/float64(time.Millisecond),
				float64(values[count*95/100])/float64(time.Millisecond),
				float64(values[count-1])/float64(time.Millisecond))
		}
	})
	for sample := range samples {
		start := time.Now()
		resolved, err := ResolveLocation(options)
		stages[0] = append(stages[0], time.Since(start))
		if err != nil || resolved != location {
			t.Fatalf("location changed: %v", err)
		}
		start = time.Now()
		hooks, err := OpenHookCounters(resolved)
		stages[1] = append(stages[1], time.Since(start))
		if err != nil {
			if hooks != nil {
				t.Fatal("failed counter open returned a connection")
			}
			if errors.Is(err, context.DeadlineExceeded) {
				openDeadlines++
			} else {
				t.Errorf("counter cycle sample %d open: %v", sample, err)
			}
			continue
		}
		// Keep initialization outside the steady counter cycle, as in the
		// real process gate's warm-ups. The counter reader now owns WAL reuse.
		if err := initial.Close(); err != nil {
			t.Fatal(err)
		}
		start = time.Now()
		err = hooks.RecordHookUsage("2026-11-13", "claude-code", false, false, 0)
		stages[2] = append(stages[2], time.Since(start))
		closeStart := time.Now()
		closeErr := hooks.Close()
		stages[3] = append(stages[3], time.Since(closeStart))
		if errors.Is(err, context.DeadlineExceeded) {
			writeDeadlines++
		} else if err != nil {
			t.Errorf("counter cycle sample %d: write=%v close=%v", sample, err, closeErr)
		} else {
			successful++
		}
		if closeErr != nil {
			t.Errorf("counter cycle sample %d close: %v", sample, closeErr)
		}
	}
	// The production API deliberately skips measurement at its 10 ms deadline.
	// Report those skips here; the real-process gate requires 200 observed saved
	// writes within its fixed attempt limit.
	// A deadline may race a commit, but must never leave half a counter pair.
	reader, err := openCounterReader(location.Hooks)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	var calls, bucket int
	if err := reader.QueryRow(`SELECT
coalesce(sum(CASE WHEN name='agent:claude-code:hook.calls' THEN value ELSE 0 END),0),
coalesce(sum(CASE WHEN name='agent:claude-code:hook.ms.0' THEN value ELSE 0 END),0)
FROM counters_go WHERE day='2026-11-13'`).Scan(&calls, &bucket); err != nil {
		t.Fatal(err)
	}
	if successful == 0 || calls != bucket || calls < successful || calls > successful+writeDeadlines {
		t.Fatalf("counter cycle persistence: calls=%d bucket=%d successful=%d write_deadlines=%d", calls, bucket, successful, writeDeadlines)
	}
	t.Logf("counter cycle committed pairs: %d", calls)
}

func TestCounterDeadlineRollsBackTheWholeBatch(t *testing.T) {
	location := testLocation(t)
	initial, err := openHooks(location, testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer initial.Close()
	// Only the second row stalls: cancellation must also undo the first row.
	if _, err := initial.db.Exec(`CREATE TRIGGER stall_bucket BEFORE INSERT ON counters_go
WHEN NEW.name='agent:codex:hook.ms.0' BEGIN
SELECT sum(value) FROM (
WITH RECURSIVE delay(value) AS (VALUES(0) UNION ALL SELECT value+1 FROM delay WHERE value<10000000)
SELECT value FROM delay);
END`); err != nil {
		t.Fatal(err)
	}
	hooks, err := openHookDatabase(location, testBudget, true)
	if err != nil {
		t.Fatal(err)
	}
	defer hooks.Close()
	if err := initial.Close(); err != nil {
		t.Fatal(err)
	}
	if err := hooks.RecordHookUsage("2026-11-13", "codex", false, false, 0); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected the unchanged usage deadline: %v", err)
	}
	var rows int
	if err := hooks.db.QueryRow("SELECT count(*) FROM counters_go").Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("partial counter batch after cancellation: rows=%d err=%v", rows, err)
	}
	if _, err := hooks.db.Exec("DROP TRIGGER stall_bucket"); err != nil {
		t.Fatal(err)
	}
	if err := hooks.recordHookUsage("2026-11-13", "codex", false, false, 0, testBudget.writer); err != nil {
		t.Fatal(err)
	}
	var total int
	if err := hooks.db.QueryRow("SELECT count(*),sum(value) FROM counters_go").Scan(&rows, &total); err != nil || rows != 2 || total != 2 {
		t.Fatalf("counter connection did not recover: rows=%d total=%d err=%v", rows, total, err)
	}
}

func TestCounterCloseRetainsCommittedWALAndAllowsAutomaticCheckpoints(t *testing.T) {
	for _, checkpoint := range []int{1000, 1} {
		t.Run(fmt.Sprint(checkpoint), func(t *testing.T) {
			location := testLocation(t)
			initial, err := openHooks(location, testBudget)
			if err != nil {
				t.Fatal(err)
			}
			if err := initial.Close(); err != nil {
				t.Fatal(err)
			}
			hooks, err := openHookDatabase(location, testBudget, true)
			if err != nil {
				t.Fatal(err)
			}
			defer hooks.Close()
			if _, err := hooks.db.Exec("DELETE FROM counter_readonly.counters_go"); err == nil {
				t.Fatal("counter guard allowed a database write")
			}
			// Initialize the WAL header outside the usage call's strict budget.
			if _, err := hooks.db.Exec("INSERT INTO counters_go VALUES('2026-11-13','agent:codex:hook.calls',0)"); err != nil {
				t.Fatal(err)
			}
			var sync int
			if err := hooks.db.QueryRow("PRAGMA synchronous").Scan(&sync); err != nil || sync != 1 {
				t.Fatalf("synchronous policy changed: %d %v", sync, err)
			}
			if checkpoint == 1 {
				// Force the existing automatic checkpoint path in a tiny fixture.
				if _, err := hooks.db.Exec("PRAGMA wal_autocheckpoint=1"); err != nil {
					t.Fatal(err)
				}
			}
			if checkpoint == 1 {
				// This subcase checks SQLite checkpoint progress, whose disk flush
				// may exceed the best-effort usage deadline on a slow filesystem.
				_, err = hooks.db.Exec(`INSERT INTO counters_go VALUES
('2026-11-13','agent:codex:hook.calls',1),('2026-11-13','agent:codex:hook.ms.0',1)
ON CONFLICT(day,name) DO UPDATE SET value=value+1`)
			} else {
				err = hooks.recordHookUsage("2026-11-13", "codex", false, false, 0, testBudget.writer)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := hooks.Close(); err != nil {
				t.Fatal(err)
			}
			// A main-file-only copy is intentionally stale when no checkpoint
			// occurred. Never use this as a backup method for a live WAL database.
			main, err := os.ReadFile(location.Hooks)
			if err != nil {
				t.Fatal(err)
			}
			copyPath := filepath.Join(t.TempDir(), "main-only.db")
			if err := os.WriteFile(copyPath, main, 0600); err != nil {
				t.Fatal(err)
			}
			copyDB, err := sql.Open("sqlite", copyPath)
			if err != nil {
				t.Fatal(err)
			}
			defer copyDB.Close()
			want := 0
			if checkpoint == 1 {
				want = 2
			}
			var mainCount int
			if err := copyDB.QueryRow("SELECT coalesce(sum(value),0) FROM counters_go").Scan(&mainCount); err != nil || mainCount != want {
				t.Fatalf("checkpoint=%d main-only count=%d want=%d: %v", checkpoint, mainCount, want, err)
			}
			// A normal independent connection must read every committed WAL row.
			reader, err := openHooks(location, testBudget)
			if err != nil {
				t.Fatal(err)
			}
			defer reader.Close()
			var total int
			if err := reader.db.QueryRow("SELECT sum(value) FROM counters_go").Scan(&total); err != nil || total != 2 {
				t.Fatalf("committed WAL counters: %d %v", total, err)
			}
		})
	}
}

func TestCounterBusyTimeoutSurvivesSessionOperations(t *testing.T) {
	location := testLocation(t)
	// Check connection policy with correctness-test limits, outside any timing
	// measurement. Production counter opens and writes retain their own caps.
	hooks, err := openHookDatabase(location, testBudget, true)
	if err != nil {
		t.Fatal(err)
	}
	defer hooks.Close()
	if err := hooks.PutSession(Session{SessionID: "fixture", Agent: "test", ProjectID: "p", Checkout: "/fixture", StartedAt: "now", LastSeenAt: "now"}); err != nil {
		t.Fatal(err)
	}
	for _, read := range []bool{false, true} {
		if read {
			if _, err := hooks.Session("fixture"); err != nil {
				t.Fatal(err)
			}
		}
		var busy int
		if err := hooks.db.QueryRow("PRAGMA busy_timeout").Scan(&busy); err != nil || busy != 1 {
			t.Fatalf("counter busy timeout after session operation: %d %v", busy, err)
		}
	}
}

func TestCommittedCountersSurviveProcessExitWithoutClose(t *testing.T) {
	location := testLocation(t)
	initial, err := openHooks(location, testBudget)
	if err != nil {
		t.Fatal(err)
	}
	if err := initial.Close(); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestCounterCrashWriter$")
	cmd.Env = append(os.Environ(), "MEX_COUNTER_CRASH_FIXTURE="+location.Hooks)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("counter process: %v\n%s", err, output)
	}
	reader, err := openHooks(location, testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	var total int
	if err := reader.db.QueryRow("SELECT sum(value) FROM counters_go").Scan(&total); err != nil || total != 2 {
		t.Fatalf("committed counters after process exit: %d %v", total, err)
	}
}

func TestCounterCrashWriter(t *testing.T) {
	path := os.Getenv("MEX_COUNTER_CRASH_FIXTURE")
	if path == "" {
		return
	}
	location := Location{Hooks: path}
	initial, err := openHooks(location, testBudget)
	if err != nil {
		t.Fatal(err)
	}
	// Initialize the first WAL header outside the best-effort usage budget.
	if _, err := initial.db.Exec("INSERT INTO counters_go VALUES('2026-11-13','agent:codex:hook.calls',0)"); err != nil {
		t.Fatal(err)
	}
	hooks, err := openHookDatabase(location, testBudget, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := initial.Close(); err != nil {
		t.Fatal(err)
	}
	if err := hooks.recordHookUsage("2026-11-13", "codex", false, false, 0, testBudget.writer); err != nil {
		t.Fatal(err)
	}
	// Deliberately bypass all SQLite Close calls after a committed statement.
	os.Exit(0)
}

func TestCounterConnectionsReuseWALAndKeepCountsAcrossClose(t *testing.T) {
	// This checks WAL identity and committed counts, not best-effort latency.
	// The real process gate and deadline rollback test retain production caps.
	location := testLocation(t)
	initial, err := openHooks(location, testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer initial.Close()
	var wal, shm os.FileInfo
	for index := 0; index < 20; index++ {
		hooks, err := openHookDatabase(location, testBudget, true)
		if err != nil {
			t.Fatal(err)
		}
		if err := initial.Close(); err != nil {
			t.Fatal(err)
		}
		var checkpoint int
		if err := hooks.db.QueryRow("PRAGMA wal_autocheckpoint").Scan(&checkpoint); err != nil || checkpoint != 1000 {
			t.Fatalf("auto-checkpoint changed: %d %v", checkpoint, err)
		}
		if err := hooks.recordHookUsage("2026-11-13", "codex", true, true, 3, testBudget.writer); err != nil {
			t.Fatal(err)
		}
		if err := hooks.Close(); err != nil {
			t.Fatal(err)
		}
		currentWAL, err := os.Stat(location.Hooks + "-wal")
		if err != nil {
			t.Fatal(err)
		}
		currentSHM, err := os.Stat(location.Hooks + "-shm")
		if err != nil {
			t.Fatal(err)
		}
		if index > 0 && (!os.SameFile(wal, currentWAL) || !os.SameFile(shm, currentSHM)) {
			t.Fatal("counter close/reopen recreated WAL sidecars")
		}
		wal, shm = currentWAL, currentSHM
	}
	reader, err := openHooks(location, testBudget)
	if err != nil {
		t.Fatal(err)
	}
	var total, rows int
	if err := reader.db.QueryRow("SELECT sum(value),count(*) FROM counters_go").Scan(&total, &rows); err != nil || total != 80 || rows != 4 {
		t.Fatalf("counters across reopen: total=%d rows=%d err=%v", total, rows, err)
	}
	reader.Close()
	// The ordinary session writer keeps its existing final-close behavior.
	if _, err := os.Stat(location.Hooks + "-wal"); !os.IsNotExist(err) {
		t.Fatalf("ordinary writer did not clean up WAL: %v", err)
	}
}

func TestCounterBatchIsAtomicAndSaturates(t *testing.T) {
	location := testLocation(t)
	hooks, err := openHooks(location, testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer hooks.Close()
	if _, err := hooks.db.Exec(`CREATE TRIGGER reject_session BEFORE INSERT ON counters_go
WHEN NEW.name='agent:codex:sessions' BEGIN SELECT RAISE(ABORT,'fixture'); END`); err != nil {
		t.Fatal(err)
	}
	if err := hooks.recordHookUsage("2026-11-13", "codex", true, true, 3, testBudget.writer); err == nil {
		t.Fatal("counter batch should fail")
	}
	var rows int
	if err := hooks.db.QueryRow("SELECT count(*) FROM counters_go").Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("partial counter batch: rows=%d err=%v", rows, err)
	}
	if _, err := hooks.db.Exec(`DROP TRIGGER reject_session;
INSERT INTO counters_go VALUES('2026-11-13','agent:codex:hook.calls',2147483647)`); err != nil {
		t.Fatal(err)
	}
	if err := hooks.recordHookUsage("2026-11-13", "codex", false, false, 3, testBudget.writer); err != nil {
		t.Fatal(err)
	}
	var calls int64
	if err := hooks.db.QueryRow("SELECT value FROM counters_go WHERE name='agent:codex:hook.calls'").Scan(&calls); err != nil || calls != 2147483647 {
		t.Fatalf("saturation changed: %d %v", calls, err)
	}
}
