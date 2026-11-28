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

func TestAgentRuleReportAttribution(t *testing.T) {
	location := testLocation(t)
	h, err := openHooks(location, testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	req := deliveryRequest()
	req.Now = time.Now()
	req.Session.Agent = "codex"
	req.Candidates[0].Moment = "bump"
	first, err := h.CheckAndMark(req)
	if err != nil || len(first.Receipts) != 1 {
		t.Fatal(first, err)
	}
	entry, project, checkout := req.Candidates[0].EntryID, req.Session.ProjectID, req.Session.Checkout
	if err := SaveAgentRuleReport(location, entry, "", project, checkout, "first", "one stop", req.Now); err != nil {
		t.Fatal(err)
	}
	req.Session.SessionID = "second"
	second, err := h.CheckAndMark(req)
	if err != nil || len(second.Receipts) != 1 {
		t.Fatal(second, err)
	}
	if err := SaveAgentRuleReport(location, entry, "second", project, checkout, "second", "named session", req.Now); err != nil {
		t.Fatal(err)
	}
	if err := SaveAgentRuleReport(location, entry, "", project, checkout, "third", "ambiguous", req.Now); err != nil {
		t.Fatal(err)
	}
	for _, want := range []struct{ detail, receipt, moment, action string }{
		{"one stop", first.Receipts[0].ID, "bump", "given"},
		{"named session", second.Receipts[0].ID, "bump", "given"},
		{"ambiguous", "", "agent-report", "control"},
	} {
		var id, moment, action string
		err := h.db.QueryRow(`SELECT d.id,d.moment,d.action FROM followups f JOIN deliveries d ON f.delivery_id=d.id WHERE f.detail=?`, want.detail).
			Scan(&id, &moment, &action)
		if err != nil || (want.receipt != "" && id != want.receipt) || moment != want.moment || action != want.action {
			t.Fatalf("%s: %s %s %s: %v", want.detail, id, moment, action, err)
		}
	}
}

func TestAgentRuleReportWaitsForWriter(t *testing.T) {
	location := testLocation(t)
	h, err := openHooks(location, testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	locker, err := openDatabase(location.Hooks, false)
	if err != nil {
		t.Fatal(err)
	}
	defer locker.Close()
	if _, err := locker.Exec("BEGIN IMMEDIATE"); err != nil {
		t.Fatal(err)
	}
	released := make(chan error, 1)
	time.AfterFunc(650*time.Millisecond, func() {
		_, err := locker.Exec("ROLLBACK")
		released <- err
	})
	err = SaveAgentRuleReport(location, "mx_abcdef", "", "project", "/repo", "lock", "report after contention", time.Now())
	if releaseErr := <-released; releaseErr != nil {
		t.Fatal(releaseErr)
	}
	if err != nil {
		t.Fatal(err)
	}
	var count int
	if err := h.db.QueryRow("SELECT count(*) FROM followups WHERE detail='report after contention'").Scan(&count); err != nil || count != 1 {
		t.Fatal(count, err)
	}
}

func TestAgentRuleReportRollsBackItsControlReceipt(t *testing.T) {
	location := testLocation(t)
	h, err := openHooks(location, testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	if _, err = h.db.Exec(`CREATE TRIGGER reject_report BEFORE INSERT ON followups
	WHEN NEW.kind='wrong' BEGIN SELECT RAISE(ABORT,'fixture refusal'); END`); err != nil {
		t.Fatal(err)
	}
	if err = SaveAgentRuleReport(location, "mx_abcdef", "", "project", "/repo", "failed", "report", time.Now()); err == nil {
		t.Fatal("the rejected write returned success")
	}
	var count int
	if err = h.db.QueryRow("SELECT (SELECT count(*) FROM sessions)+(SELECT count(*) FROM deliveries)+(SELECT count(*) FROM followups)").Scan(&count); err != nil || count != 0 {
		t.Fatal(count, err)
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
