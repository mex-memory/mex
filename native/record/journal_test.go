package record

import (
	"database/sql"
	"fmt"
	"strings"
	"testing"
	"time"
)

func journalBytes(t *testing.T, h *Hooks) (counted, actual int64) {
	t.Helper()
	if err := h.db.QueryRow(`SELECT bytes FROM journal_size`).Scan(&counted); err != nil {
		t.Fatal(err)
	}
	if err := h.db.QueryRow(`SELECT coalesce(sum(` + journalRowBytes + `),0) FROM journal`).Scan(&actual); err != nil {
		t.Fatal(err)
	}
	return counted, actual
}

func trimAll(t *testing.T, h *Hooks, now time.Time) int {
	t.Helper()
	starts := 0
	for more := true; more; starts++ {
		var err error
		if more, err = h.TrimJournal(now); err != nil {
			t.Fatal(err)
		}
		if starts > 100 {
			t.Fatal("retention never finished")
		}
	}
	return starts
}

func TestJournalAppendKeepsRowsAndKinds(t *testing.T) {
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	one := 1
	s := Session{SessionID: "s1", Agent: "claude-code", ProjectID: "g-aaaaaaaaaaaaaaaaaaaaaaaa", Checkout: "/r"}
	if err := h.AppendJournal(s, "2026-11-15T00:00:00Z", []JournalRow{{Kind: "typed", Text: "fix the build"}, {Kind: "command", Text: "npm test", ExitCode: &one}, {Kind: "edit", Text: "src/a.ts"}}); err != nil {
		t.Fatal(err)
	}
	// A pause survives: the journal never rewrites the session row.
	if err := h.SetSessionPaused(Session{SessionID: "s1", Agent: "claude-code", ProjectID: s.ProjectID, Checkout: "/r", Paused: true}, func(bool) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if err := h.AppendJournal(s, "2026-11-15T00:00:01Z", []JournalRow{{Kind: "typed", Text: "again", Marks: "pasted"}}); err != nil {
		t.Fatal(err)
	}
	if got, _ := h.Session("s1"); got == nil || !got.Paused {
		t.Fatalf("pause lost: %+v", got)
	}
	rows, err := h.JournalRows("s1", 10)
	if err != nil || len(rows) != 4 || rows[1].ExitCode == nil || *rows[1].ExitCode != 1 || rows[0].ExitCode != nil ||
		rows[2].Kind != "edit" || rows[2].Text != "src/a.ts" || rows[2].ExitCode != nil || rows[3].Marks != "pasted" {
		t.Fatalf("%+v %v", rows, err)
	}
	for _, bad := range []JournalRow{{Kind: "agent", Text: "x"}, {Kind: "typed", Text: "x", Marks: "sdk"}, {Kind: "edit", Text: ""}, {Kind: "edit", Text: "a.ts", ExitCode: &one}} {
		if err := h.AppendJournal(s, "t", []JournalRow{bad}); err == nil {
			t.Fatalf("accepted %+v", bad)
		}
	}
	// Retention under both limits deletes nothing, consumed or not.
	if starts := trimAll(t, h, time.Date(2026, 11, 20, 0, 0, 0, 0, time.UTC)); starts != 1 {
		t.Fatal(starts)
	}
	if rows, _ := h.JournalRows("s1", 10); len(rows) != 4 {
		t.Fatalf("rows lost: %+v", rows)
	}
	if counted, actual := journalBytes(t, h); counted != actual || counted == 0 {
		t.Fatalf("byte total %d, rows hold %d", counted, actual)
	}
}

func TestJournalAgeLimit(t *testing.T) {
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	now := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	s := Session{SessionID: "s1", Agent: "codex", ProjectID: "p", Checkout: "/r"}
	// 5,000 rows past 90 days, then rows just inside it: a backlog takes
	// several bounded session starts, and stops at the first kept row.
	old := now.Add(-JournalMaxAge - time.Hour)
	for i := 0; i < 50; i++ {
		batch := make([]JournalRow, 100)
		for j := range batch {
			batch[j] = JournalRow{Kind: "edit", Text: fmt.Sprintf("old/%d.go", i*100+j)}
		}
		if err := h.AppendJournal(s, old.Add(time.Duration(i)*time.Second).Format(time.RFC3339Nano), batch); err != nil {
			t.Fatal(err)
		}
	}
	fresh := now.Add(-JournalMaxAge + time.Minute).Format(time.RFC3339Nano)
	if err := h.AppendJournal(s, fresh, []JournalRow{{Kind: "typed", Text: "kept"}, {Kind: "command", Text: "go test ./..."}}); err != nil {
		t.Fatal(err)
	}
	more, err := h.TrimJournal(now)
	if err != nil || !more {
		t.Fatal("one session start should leave a backlog", more, err)
	}
	var left int
	h.db.QueryRow(`SELECT count(*) FROM journal`).Scan(&left)
	if want := 5002 - journalTrimSteps*journalTrimStep; left != want {
		t.Fatalf("one start deleted %d rows, want at most %d", 5002-left, journalTrimSteps*journalTrimStep)
	}
	trimAll(t, h, now)
	rows, _ := h.JournalRows("s1", 10)
	if len(rows) != 2 || rows[0].Text != "kept" {
		t.Fatalf("%+v", rows)
	}
	if counted, actual := journalBytes(t, h); counted != actual {
		t.Fatalf("byte total %d, rows hold %d", counted, actual)
	}
}

func TestJournalSizeLimit(t *testing.T) {
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	defer func(cap int64) { journalCap = cap }(journalCap)
	journalCap = 1 << 20
	now := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC)
	ts := now.Format(time.RFC3339Nano)
	s := Session{SessionID: "s1", Agent: "claude-code", ProjectID: "p", Checkout: "/r"}
	big := strings.Repeat("x", 16<<10)
	for i := 0; i < 100; i++ {
		if err := h.AppendJournal(s, ts, []JournalRow{{Kind: "typed", Text: fmt.Sprintf("%03d", i) + big}}); err != nil {
			t.Fatal(err)
		}
	}
	// Appends only check the running total every 32 rows and delete a bounded
	// step, so the journal stays near the cap between session starts.
	counted, actual := journalBytes(t, h)
	if counted != actual || counted > journalCap+32*(17<<10) {
		t.Fatalf("append kept %d (rows hold %d)", counted, actual)
	}
	trimAll(t, h, now)
	counted, actual = journalBytes(t, h)
	if counted != actual || counted > journalCap || counted < journalCap-(17<<10) {
		t.Fatalf("cap: %d (rows hold %d)", counted, actual)
	}
	var newest string
	h.db.QueryRow(`SELECT substr(text,1,3) FROM journal ORDER BY id DESC LIMIT 1`).Scan(&newest)
	if newest != "099" {
		t.Fatal("newest row dropped", newest)
	}
}

// Migration 15 rebuilds the journal for the edit kind: rows, ids, the index
// and the id allocation point survive, and the byte total starts right.
func TestJournalMigrationKeepsRowsAndIDs(t *testing.T) {
	location := testLocation(t)
	db, err := sql.Open("sqlite", location.Hooks)
	if err != nil {
		t.Fatal(err)
	}
	for i, name := range hookMigrationFiles[:14] {
		data, err := schemas.ReadFile("schema/hooks/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(string(data) + fmt.Sprintf(";PRAGMA user_version=%d", i+1)); err != nil {
			t.Fatal(name, err)
		}
	}
	if _, err := db.Exec(`INSERT INTO sessions VALUES('s1','codex','p','/r','t','t',0);
		INSERT INTO journal(session_id,ts,kind,text,exit_code,marks) VALUES('s1','t','typed','one',NULL,''),('s1','t','command','npm test',1,''),('s1','t','typed','three',NULL,'pasted');
		DELETE FROM journal WHERE id=3`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	h, err := openHooks(location, testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	if err := h.AppendJournal(Session{SessionID: "s1"}, "t", []JournalRow{{Kind: "edit", Text: "src/a.ts"}}); err != nil {
		t.Fatal(err)
	}
	rows, err := h.JournalRows("s1", 10)
	if err != nil || len(rows) != 3 || rows[0].ID != 1 || rows[1].ID != 2 || *rows[1].ExitCode != 1 || rows[2].ID != 4 || rows[2].Kind != "edit" {
		t.Fatalf("ids reused or rows lost: %+v %v", rows, err)
	}
	var index string
	if err := h.db.QueryRow(`SELECT sql FROM sqlite_schema WHERE name='journal_session_id'`).Scan(&index); err != nil || !strings.Contains(index, "journal(session_id,id)") {
		t.Fatal("index lost", index, err)
	}
	if counted, actual := journalBytes(t, h); counted != actual {
		t.Fatalf("byte total %d, rows hold %d", counted, actual)
	}
}

func TestShowOnceAcrossSessions(t *testing.T) {
	h, err := OpenHooks(testLocation(t))
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	a := Session{SessionID: "a", Agent: "claude-code", ProjectID: "p", Checkout: "/r"}
	b := Session{SessionID: "b", Agent: "codex", ProjectID: "p", Checkout: "/r"}
	if ok, err := h.ShowOnce(a, "handoff:x", "t"); !ok || err != nil {
		t.Fatal(ok, err)
	}
	if ok, err := h.ShowOnce(b, "handoff:x", "t"); ok || err != nil {
		t.Fatal("shown twice", err)
	}
	if ok, _ := h.ShowOnce(b, "handoff:y", "t"); !ok {
		t.Fatal("other notice blocked")
	}
	if got, _ := h.Delivered("a", "mx_none"); got {
		t.Fatal("nothing was delivered")
	}
}

// The byte total follows updates too, and a call id counts toward it. Only a
// command without an exit code keeps a call id.
func TestJournalSizeFollowsUpdatesAndCallIDs(t *testing.T) {
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	s := Session{SessionID: "s1", Agent: "codex", ProjectID: "p", Checkout: "/r"}
	ts := time.Date(2026, 11, 20, 12, 0, 0, 0, time.UTC).Format(time.RFC3339Nano)
	one := 1
	if err := h.AppendJournal(s, ts, []JournalRow{{Kind: "command", Text: "npm test", CallID: "exec-1"}, {Kind: "typed", Text: "short"}}); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []JournalRow{{Kind: "typed", Text: "x", CallID: "exec-2"}, {Kind: "command", Text: "x", ExitCode: &one, CallID: "exec-3"},
		{Kind: "command", Text: "x", CallID: strings.Repeat("c", MaxCallID+1)}} {
		if err := h.AppendJournal(s, ts, []JournalRow{bad}); err == nil {
			t.Fatalf("accepted %+v", bad)
		}
	}
	if rows, _ := h.JournalRows("s1", 10); len(rows) != 2 || rows[0].CallID != "exec-1" || rows[1].CallID != "" {
		t.Fatalf("%+v", rows)
	}
	for _, update := range []string{`UPDATE journal SET text=text||? WHERE kind='typed'`, `UPDATE journal SET call_id=substr(?,1,100) WHERE kind='command'`,
		`UPDATE journal SET ts=ts||? WHERE kind='typed'`} {
		if _, err := h.db.Exec(update, strings.Repeat("y", 300)); err != nil {
			t.Fatal(err)
		}
		if counted, actual := journalBytes(t, h); counted != actual {
			t.Fatalf("after %q: counted %d, rows hold %d", update, counted, actual)
		}
	}
	if _, err := h.db.Exec(`UPDATE journal SET call_id=NULL`); err != nil {
		t.Fatal(err)
	}
	if counted, actual := journalBytes(t, h); counted != actual {
		t.Fatalf("counted %d, rows hold %d", counted, actual)
	}
}

func TestJournalAfterReadsPastACursor(t *testing.T) {
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	zero := 0
	s := Session{SessionID: "s1", Agent: "codex", ProjectID: "g-aaaaaaaaaaaaaaaaaaaaaaaa", Checkout: "/r"}
	other := Session{SessionID: "s2", Agent: "codex", ProjectID: s.ProjectID, Checkout: "/r"}
	if err := h.AppendJournal(s, "2026-11-25T00:00:00Z", []JournalRow{{Kind: "edit", Text: "a.ts"}, {Kind: "command", Text: "npm test", ExitCode: &zero}}); err != nil {
		t.Fatal(err)
	}
	if err := h.AppendJournal(other, "2026-11-25T00:00:01Z", []JournalRow{{Kind: "edit", Text: "b.ts"}}); err != nil {
		t.Fatal(err)
	}
	if err := h.AppendJournal(s, "2026-11-25T00:00:02Z", []JournalRow{{Kind: "edit", Text: "c.ts"}, {Kind: "command", Text: strings.Repeat("x", 9000)}}); err != nil {
		t.Fatal(err)
	}
	all, err := h.JournalAfter("s1", 0, 10)
	if err != nil || len(all) != 4 || all[0].Text != "a.ts" || all[1].ExitCode == nil || *all[1].ExitCode != 0 || all[3].ExitCode != nil {
		t.Fatalf("%+v %v", all, err)
	}
	if len(all[3].Text) != 8192 {
		t.Fatalf("text not cut: %d", len(all[3].Text))
	}
	after, err := h.JournalAfter("s1", all[1].ID, 10)
	if err != nil || len(after) != 2 || after[0].Text != "c.ts" {
		t.Fatalf("%+v %v", after, err)
	}
	if limited, _ := h.JournalAfter("s1", 0, 1); len(limited) != 1 {
		t.Fatalf("limit ignored: %+v", limited)
	}
}
