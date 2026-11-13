package record

import (
	"os"
	"testing"
)

func TestCounterConnectionsReuseWALAndKeepCountsAcrossClose(t *testing.T) {
	location := testLocation(t)
	initial, err := OpenHooks(location)
	if err != nil {
		t.Fatal(err)
	}
	initial.Close()
	var wal, shm os.FileInfo
	for index := 0; index < 20; index++ {
		hooks, err := OpenHookCounters(location)
		if err != nil {
			t.Fatal(err)
		}
		var checkpoint int
		if err := hooks.db.QueryRow("PRAGMA wal_autocheckpoint").Scan(&checkpoint); err != nil || checkpoint != 1000 {
			t.Fatalf("auto-checkpoint changed: %d %v", checkpoint, err)
		}
		if err := hooks.RecordHookUsage("2026-11-13", "codex", true, true, 3); err != nil {
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
	reader, err := OpenHooks(location)
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
	hooks, err := OpenHooks(location)
	if err != nil {
		t.Fatal(err)
	}
	defer hooks.Close()
	if _, err := hooks.db.Exec(`CREATE TRIGGER reject_session BEFORE INSERT ON counters_go
WHEN NEW.name='agent:codex:sessions' BEGIN SELECT RAISE(ABORT,'fixture'); END`); err != nil {
		t.Fatal(err)
	}
	if err := hooks.RecordHookUsage("2026-11-13", "codex", true, true, 3); err == nil {
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
	if err := hooks.RecordHookUsage("2026-11-13", "codex", false, false, 3); err != nil {
		t.Fatal(err)
	}
	var calls int64
	if err := hooks.db.QueryRow("SELECT value FROM counters_go WHERE name='agent:codex:hook.calls'").Scan(&calls); err != nil || calls != 2147483647 {
		t.Fatalf("saturation changed: %d %v", calls, err)
	}
}
