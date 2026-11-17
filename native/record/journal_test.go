package record

import (
	"strings"
	"testing"
)

func TestJournalAppendPruneAndCap(t *testing.T) {
	h, err := OpenHooks(testLocation(t))
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	one := 1
	s := Session{SessionID: "s1", Agent: "claude-code", ProjectID: "g-aaaaaaaaaaaaaaaaaaaaaaaa", Checkout: "/r"}
	if err := h.AppendJournal(s, "2026-11-15T00:00:00Z", []JournalRow{{Kind: "typed", Text: "fix the build"}, {Kind: "command", Text: "npm test", ExitCode: &one}}); err != nil {
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
	if err != nil || len(rows) != 3 || rows[1].ExitCode == nil || *rows[1].ExitCode != 1 || rows[0].ExitCode != nil || rows[2].Marks != "pasted" {
		t.Fatalf("%+v %v", rows, err)
	}
	if err := h.AppendJournal(s, "t", []JournalRow{{Kind: "agent", Text: "x"}}); err == nil {
		t.Fatal("agent text accepted")
	}
	if err := h.AppendJournal(s, "t", []JournalRow{{Kind: "typed", Text: "x", Marks: "sdk"}}); err == nil {
		t.Fatal("unknown mark accepted")
	}
	// Another project's rows survive a prune.
	other := Session{SessionID: "s2", Agent: "codex", ProjectID: "g-bbbbbbbbbbbbbbbbbbbbbbbb", Checkout: "/o"}
	if err := h.AppendJournal(other, "t", []JournalRow{{Kind: "typed", Text: "other"}}); err != nil {
		t.Fatal(err)
	}
	if err := h.PruneJournal(s.ProjectID, rows[1].ID); err != nil {
		t.Fatal(err)
	}
	if rows, _ := h.JournalRows("s1", 10); len(rows) != 1 || rows[0].Text != "again" {
		t.Fatalf("prune: %+v", rows)
	}
	if rows, _ := h.JournalRows("s2", 10); len(rows) != 1 {
		t.Fatalf("other project pruned: %+v", rows)
	}

	// The cap keeps the newest text and drops the oldest.
	big := strings.Repeat("x", 64<<10)
	for i := 0; i < 100; i++ {
		if err := h.AppendJournal(s, "t", []JournalRow{{Kind: "typed", Text: big}}); err != nil {
			t.Fatal(err)
		}
	}
	if err := h.TrimJournal(); err != nil {
		t.Fatal(err)
	}
	var total int64
	if err := h.db.QueryRow(`SELECT coalesce(sum(length(CAST(text AS BLOB))),0) FROM journal`).Scan(&total); err != nil || total > JournalCapBytes || total < JournalCapBytes-(64<<10) {
		t.Fatalf("cap: %d %v", total, err)
	}
	var newest string
	h.db.QueryRow(`SELECT text FROM journal ORDER BY id DESC LIMIT 1`).Scan(&newest)
	if newest != big {
		t.Fatal("newest row dropped")
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
