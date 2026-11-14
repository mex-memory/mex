package record

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func counterTotals(t *testing.T, location Location) map[string]int {
	t.Helper()
	db, err := openDatabase(location.Hooks, false)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	rows, err := db.Query("SELECT name,value FROM counters_go")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var name string
		var value int
		if err := rows.Scan(&name, &value); err != nil {
			t.Fatal(err)
		}
		out[name] += value
	}
	return out
}

// A write that misses its deadline is kept, and the next write adds it: no
// hook call is lost.
func TestMissedCounterWriteIsAddedByTheNextCall(t *testing.T) {
	location := testLocation(t)
	initial, err := openHooks(location, testBudget)
	if err != nil {
		t.Fatal(err)
	}
	initial.Close()

	lock, err := openDatabase(location.Hooks, false)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	if _, err := lock.Exec("BEGIN IMMEDIATE"); err != nil {
		t.Fatal(err)
	}
	if err := RecordHookUsageOrDefer(location, "2026-11-14", "claude-code", true, false, 3); err == nil {
		t.Fatal("the write got past a held lock")
	}
	pending, err := os.ReadFile(filepath.Join(location.Directory, PendingCountersName))
	if err != nil || !strings.Contains(string(pending), "2026-11-14\tagent:claude-code:sessions\t1\n") {
		t.Fatalf("missed counts weren't kept: %q %v", pending, err)
	}
	if _, err := lock.Exec("ROLLBACK"); err != nil {
		t.Fatal(err)
	}

	if err := RecordHookUsageOrDefer(location, "2026-11-14", "claude-code", false, false, 3); err != nil {
		t.Fatal(err)
	}
	got := counterTotals(t, location)
	if got["agent:claude-code:hook.calls"] != 2 || got["agent:claude-code:sessions"] != 1 || got["agent:claude-code:hook.ms.2"] != 2 {
		t.Fatalf("counts: %v", got)
	}
	if _, err := os.Stat(filepath.Join(location.Directory, PendingCountersName)); !os.IsNotExist(err) {
		t.Fatal("pending file left after it was added")
	}
	if claims, _ := filepath.Glob(filepath.Join(location.Directory, PendingCountersName+".*")); len(claims) != 0 {
		t.Fatalf("claim files left: %v", claims)
	}
}

// Only counter rows a hook writes are read back from the file: nothing else
// can enter counters_go through it.
func TestPendingCountersAcceptOnlyHookCounters(t *testing.T) {
	got := parsePendingCounts(strings.NewReader(strings.Join([]string{
		"2026-11-14\tagent:codex:hook.calls\t2",
		"2026-11-14\tagent:codex:hook.calls\t1",
		"2026-11-14\tagent:codex:/home/me/private\t1",
		"2026-11-14\tagent:other:hook.calls\t1",
		"not-a-day\tagent:codex:sessions\t1",
		"2026-11-14\tagent:codex:sessions\t-3",
		"2026-11-14\tagent:codex:sessions",
		"",
	}, "\n")))
	if len(got) != 1 || got[counterKey{"2026-11-14", "agent:codex:hook.calls"}] != 3 {
		t.Fatalf("parsed: %v", got)
	}
}

// The file is bounded: past the limit, missed counts are dropped as before.
func TestPendingCountersAreBounded(t *testing.T) {
	location := testLocation(t)
	if err := os.MkdirAll(location.Directory, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(location.Directory, PendingCountersName)
	if err := os.WriteFile(path, make([]byte, maxPendingBytes), 0o600); err != nil {
		t.Fatal(err)
	}
	deferCounts(location, map[counterKey]int{{"2026-11-14", "agent:codex:hook.calls"}: 1})
	if info, err := os.Stat(path); err != nil || info.Size() != maxPendingBytes {
		t.Fatalf("a full file grew: %v %v", info, err)
	}
}
