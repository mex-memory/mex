package record

import (
	"testing"
	"time"
)

func TestCompactionJournalUsesRecordedSessionCheckout(t *testing.T) {
	h, err := OpenHooks(testLocation(t))
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	session := Session{SessionID: "shared-session", Agent: "claude-code", ProjectID: "project", Checkout: "/work"}
	other := session
	other.Checkout = "/other-worktree"
	at := time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)
	for _, scope := range []Session{session, other} {
		if err := h.AppendJournal(scope, at.Format(time.RFC3339Nano), []JournalRow{{Kind: "typed", Text: "Continue"}}); err != nil {
			t.Fatal(err)
		}
	}
	captured, err := h.JournalRows(session.SessionID, 10)
	if err != nil || len(captured) != 2 {
		t.Fatalf("capture lost a cross-checkout row: %d rows, %v", len(captured), err)
	}
	from, until := at.Add(-time.Second), at.Add(time.Second)
	rows, partial, err := h.CompactionJournal(other, from, until)
	if err != nil || partial || len(rows) != 0 {
		t.Fatalf("mismatched checkout read %d rows, partial=%t, err=%v", len(rows), partial, err)
	}
	rows, partial, err = h.CompactionJournal(session, from, until)
	if err != nil || partial || len(rows) != 2 {
		t.Fatalf("recorded checkout read %d rows, partial=%t, err=%v", len(rows), partial, err)
	}
}
