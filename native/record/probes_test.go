package record

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestFailingCommandRerunIntent(t *testing.T) {
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	req := deliveryRequest()
	req.Candidates = nil
	failure := strings.Repeat("a", 64)
	req.Commands, req.FailedCommand = []string{failure}, failure
	got, err := h.CheckAndMark(req)
	if err != nil || got.Epoch.Intent != "investigating" {
		t.Fatal(got, err)
	}
	req.FailedCommand = ""
	req.Commands = []string{strings.Repeat("b", 64)}
	got, err = h.CheckAndMark(req)
	if err != nil || got.Epoch.Intent != "investigating" {
		t.Fatal(got, err)
	}
	req.Commands = []string{failure}
	got, err = h.CheckAndMark(req)
	if err != nil || got.Epoch.Intent != "reproducing" {
		t.Fatal(got, err)
	}
	req.Reason = "clear"
	got, err = h.CheckAndMark(req)
	if err != nil || got.Epoch.Intent != "investigating" || got.Epoch.LastFailure != "" {
		t.Fatal(got, err)
	}
	req.Reason, req.Intent, req.FailedCommand = "", "changing", failure
	_, err = h.CheckAndMark(req)
	if err != nil {
		t.Fatal(err)
	}
	got, err = h.CheckAndMark(req)
	if err != nil || got.Epoch.Intent != "changing" {
		t.Fatal(got, err)
	}
}

func TestIntentMigrationFromFive(t *testing.T) {
	l := testLocation(t)
	db, err := openDatabase(l.Hooks, false)
	if err != nil {
		t.Fatal(err)
	}
	var steps []migration
	for i, name := range []string{"0001_init.sql", "0002_delivery.sql", "0003_followups.sql", "0004_rendering.sql", "0005_probes.sql"} {
		s, err := schemas.ReadFile("schema/hooks/" + name)
		if err != nil {
			t.Fatal(err)
		}
		steps = append(steps, migration{i + 1, string(s)})
	}
	if err = migrate(context.Background(), db, steps); err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`INSERT INTO sessions VALUES('s','codex','p','/repo','old','old',0);
		INSERT INTO epochs(session_id,epoch,started_at,intent) VALUES('s',0,'old','changing');
		INSERT INTO deliveries(id,session_id,epoch,ts,moment,entry_id,form,tokens,action,title)
		VALUES('d','s',0,'old','read','mx_abcdef','full',12,'given','Keep the pool')`)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	h, err := openHooks(l, testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	var intent, failure, title string
	err = h.db.QueryRow(`SELECT intent,last_failure,title FROM epochs JOIN deliveries USING(session_id,agent_id,epoch) WHERE deliveries.id='d'`).Scan(&intent, &failure, &title)
	if err != nil || intent != "changing" || failure != "" || title != "Keep the pool" {
		t.Fatal(intent, failure, title, err)
	}
}

func TestExplicitProbeRefusesAmbiguousContexts(t *testing.T) {
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	req := deliveryRequest()
	req.Now = time.Now()
	req.Session.Agent = "codex"
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	if ok, err := h.ExplicitProbe(req.Candidates[0].EntryID, "opened", "", req.Session.ProjectID, req.Session.Checkout); err != nil || !ok {
		t.Fatal(ok, err)
	}
	req.Session.SessionID = "second"
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	if ok, err := h.ExplicitProbe(req.Candidates[0].EntryID, "wrong", "", req.Session.ProjectID, req.Session.Checkout); err != nil || ok {
		t.Fatal(ok, err)
	}
	if ok, err := h.ExplicitProbe(req.Candidates[0].EntryID, "wrong", "second", req.Session.ProjectID, req.Session.Checkout); err != nil || !ok {
		t.Fatal(ok, err)
	}
}

func TestProbeDeduplicationIsolationAndCounts(t *testing.T) {
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	req := deliveryRequest()
	req.Session.Agent = "codex"
	req.Candidates[0].Title = "Use the pool"
	req.Candidates[0].Kind = "recipe"
	req.Candidates[0].Level = "team"
	got, err := h.CheckAndMark(req)
	if err != nil || len(got.Receipts) != 1 {
		t.Fatal(got, err)
	}
	receipt := got.Receipts[0]
	req.Candidates = nil
	req.Probes = []FollowupObservation{{ReceiptID: receipt.ID, EntryID: receipt.EntryID, Kind: "followed"}}
	req.Touches = []string{receipt.ID}
	for i := 0; i < 2; i++ {
		if _, err = h.CheckAndMark(req); err != nil {
			t.Fatal(err)
		}
	}
	var n int
	if err = h.db.QueryRow("SELECT count(*) FROM followups").Scan(&n); err != nil || n != 1 {
		t.Fatal(n, err)
	}
	if err = h.db.QueryRow("SELECT value FROM counters_go WHERE name='agent:codex:knowledge.followed'").Scan(&n); err != nil || n != 1 {
		t.Fatal(n, err)
	}
	req.Session.Checkout = "/other"
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	if err = h.db.QueryRow("SELECT count(*) FROM followups").Scan(&n); err != nil || n != 1 {
		t.Fatal(n, err)
	}
	req.Session.Checkout = "/repo"
	req.EndEpoch = true
	req.Probes = nil
	req.Touches = nil
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	summary, err := ReadWhat(h.pathForTest(t), req.Session.SessionID, req.Session.ProjectID, req.Session.Checkout)
	if err != nil || summary.Gave != 1 || summary.EstimatedFalse != 0 || summary.ClosedDeliveries != 1 || summary.Items[0].Title != "Use the pool" {
		t.Fatal(summary, err)
	}
}

func (h *Hooks) pathForTest(t *testing.T) string {
	t.Helper()
	var seq int
	var name, path string
	if err := h.db.QueryRow("PRAGMA database_list").Scan(&seq, &name, &path); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestWhatAbsentDoesNotCreate(t *testing.T) {
	path := t.TempDir() + "/absent.db"
	s, err := ReadWhat(path, "s", "p", "/repo")
	if err != nil || s.Gave != 0 {
		t.Fatal(s, err)
	}
}

func TestProbeMigrationKeepsExistingReceipts(t *testing.T) {
	l := testLocation(t)
	db, err := openDatabase(l.Hooks, false)
	if err != nil {
		t.Fatal(err)
	}
	var steps []migration
	for i, name := range []string{"0001_init.sql", "0002_delivery.sql", "0003_followups.sql", "0004_rendering.sql"} {
		s, _ := schemas.ReadFile("schema/hooks/" + name)
		steps = append(steps, migration{i + 1, string(s)})
	}
	if err = migrate(context.Background(), db, steps); err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`INSERT INTO sessions VALUES('s','codex','p','/repo','old','old',0);INSERT INTO epochs(session_id,epoch,started_at) VALUES('s',0,'old');INSERT INTO deliveries(id,session_id,epoch,ts,moment,entry_id,form,tokens,action) VALUES('d','s',0,'old','read','mx_abcdef','full',12,'given')`)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	h, err := openHooks(l, testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	var intent, title string
	if err = h.db.QueryRow(`SELECT intent,title FROM epochs JOIN deliveries USING(session_id,agent_id,epoch) WHERE deliveries.id='d'`).Scan(&intent, &title); err != nil || intent != "working" || title != "" {
		t.Fatal(intent, title, err)
	}
}
