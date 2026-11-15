package record

import (
	"context"
	"strings"
	"testing"
)

func hooksAtTwo(t *testing.T) Location {
	t.Helper()
	l := testLocation(t)
	db, err := openDatabase(l.Hooks, false)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	for _, name := range []string{"0001_init.sql", "0002_delivery.sql"} {
		b, err := schemas.ReadFile("schema/hooks/" + name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = db.Exec(string(b)); err != nil {
			t.Fatal(err)
		}
	}
	_, err = db.Exec(`PRAGMA user_version=2;
 INSERT INTO sessions VALUES('kept','test','p','/repo','old','old',0);
 INSERT INTO epochs(session_id,agent_id,epoch,started_at,tokens_sent) VALUES('kept','',0,'old',9);
 INSERT INTO deliveries(id,session_id,agent_id,epoch,ts,moment,entry_id,form,tokens,action)
 VALUES('old','kept','',0,'old','read','e','full',9,'given');
 INSERT INTO followups(id,delivery_id,ts,kind,detail) VALUES
 (11,'old','old','followed','keep'),(12,'old','old','missed',NULL),
 (13,'old','old','opened',''),(14,'old','old','wrong','keep'),
 (15,'old','old','edit',NULL),(16,'old','old','command','keep');`)
	if err != nil {
		t.Fatal(err)
	}
	return l
}
func TestFollowupMigrationFromTwoPreservesDataAndChecks(t *testing.T) {
	l := hooksAtTwo(t)
	h, err := openHooks(l, testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	version, err := schemaVersion(context.Background(), h.db)
	if err != nil || version != SchemaVersion {
		t.Fatal(version, err)
	}
	var n int
	if err = h.db.QueryRow("SELECT count(*) FROM followups WHERE id BETWEEN 11 AND 16").Scan(&n); err != nil || n != 6 {
		t.Fatal(n, err)
	}
	var detail string
	if err = h.db.QueryRow("SELECT detail FROM followups WHERE id=11").Scan(&detail); err != nil || detail != "keep" {
		t.Fatal(detail, err)
	}
	for _, kind := range []string{"failure", "delivered-later", "nothing"} {
		if _, err = h.db.Exec("INSERT INTO followups(delivery_id,ts,kind) VALUES('old','new',?)", kind); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = h.db.Exec("INSERT INTO followups(delivery_id,ts,kind) VALUES('old','new','invalid')"); err == nil {
		t.Fatal("lost CHECK")
	}
	if _, err = h.db.Exec("INSERT INTO followups(delivery_id,ts,kind) VALUES('absent','new','nothing')"); err == nil {
		t.Fatal("lost FK")
	}
	if _, err = h.db.Exec("PRAGMA foreign_key_check"); err != nil {
		t.Fatal(err)
	}
	h.Close()
	h, err = openHooks(l, testBudget)
	if err != nil {
		t.Fatal(err)
	}
	h.Close()
}
func TestFollowupMigrationOversizeRollsBack(t *testing.T) {
	l := hooksAtTwo(t)
	db, err := openDatabase(l.Hooks, false)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<100001)
 INSERT INTO followups(delivery_id,ts,kind) SELECT 'old','old','edit' FROM seq`)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	if h, err := openHooks(l, testBudget); err == nil {
		h.Close()
		t.Fatal("unbounded migration accepted")
	}
	db, err = openDatabase(l.Hooks, false)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	version, err := schemaVersion(context.Background(), db)
	if err != nil || version != 2 {
		t.Fatal("migration advanced", version, err)
	}
	var n int
	if err = db.QueryRow("SELECT count(*) FROM followups").Scan(&n); err != nil || n != 100007 {
		t.Fatal("lost rows", n, err)
	}
	if _, err = db.Exec("SELECT * FROM followups_next"); err == nil {
		t.Fatal("partial migration survived")
	}
}
func TestHoldbackFollowupsIsolationDedupeAndEnd(t *testing.T) {
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	req := deliveryRequest()
	req.Candidates[0].Action = "held-back"
	held, err := h.CheckAndMark(req)
	if err != nil {
		t.Fatal(err)
	}
	receipt := held.Receipts[0].ID
	req.Candidates = nil
	req.Observations = []FollowupObservation{{EntryID: "mx_abcdef", ReceiptID: receipt, Kind: "missed"}}
	for _, scope := range []string{"session", "agent", "project", "checkout"} {
		other := req
		switch scope {
		case "session":
			other.Session.SessionID = "other"
		case "agent":
			other.AgentID = "child"
		case "project":
			other.Session.ProjectID = "other"
		case "checkout":
			other.Session.Checkout = "/other"
		}
		if _, err = h.CheckAndMark(other); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 2; i++ {
		if _, err = h.CheckAndMark(req); err != nil {
			t.Fatal(err)
		}
	}
	var n int
	h.db.QueryRow("SELECT count(*) FROM followups WHERE delivery_id=?", receipt).Scan(&n)
	if n != 1 {
		t.Fatal("duplicated or foreign observations", n)
	}
	req.Observations = nil
	req.Candidates = deliveryRequest().Candidates
	req.Candidates[0].Exempt = true
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	h.db.QueryRow("SELECT count(*) FROM followups WHERE delivery_id=? AND kind='delivered-later'", receipt).Scan(&n)
	if n != 1 {
		t.Fatal("lost later delivery")
	}
	req.Candidates[0].EntryID = "another"
	req.Candidates[0].Action = "withheld"
	withheld, err := h.CheckAndMark(req)
	if err != nil {
		t.Fatal(err)
	}
	req.Candidates = nil
	req.EndEpoch = true
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	h.db.QueryRow("SELECT count(*) FROM followups WHERE delivery_id=? AND kind='nothing'", withheld.Receipts[0].ID).Scan(&n)
	if n != 1 {
		t.Fatal("end not recorded once", n)
	}
	h.db.QueryRow("SELECT count(*) FROM followups WHERE delivery_id=? AND kind='nothing'", receipt).Scan(&n)
	if n != 0 {
		t.Fatal("claimed nothing after observation")
	}
	req.EndEpoch = false
	req.Reason = "compact"
	req.CompactSignal = 1
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	req.Observations = []FollowupObservation{{EntryID: "another", ReceiptID: withheld.Receipts[0].ID, Kind: "command"}}
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	h.db.QueryRow("SELECT count(*) FROM followups WHERE delivery_id=? AND kind='command'", withheld.Receipts[0].ID).Scan(&n)
	if n != 0 {
		t.Fatal("crossed epoch")
	}
}
func TestHoldbackObservationRollsBackWithDelivery(t *testing.T) {
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	req := deliveryRequest()
	req.Candidates[0].Action = "held-back"
	res, err := h.CheckAndMark(req)
	if err != nil {
		t.Fatal(err)
	}
	req.Observations = []FollowupObservation{{EntryID: "mx_abcdef", ReceiptID: res.Receipts[0].ID, Kind: "failure"}}
	req.Candidates = []DeliveryCandidate{{EntryID: "bad", Form: "bad"}}
	if _, err = h.CheckAndMark(req); err == nil {
		t.Fatal("accepted invalid candidate")
	}
	var n int
	h.db.QueryRow("SELECT count(*) FROM followups").Scan(&n)
	if n != 0 {
		t.Fatal("partial followup committed")
	}
	req.Candidates = nil
	req.Observations[0].Kind = "text"
	if _, err = h.CheckAndMark(req); err == nil || !strings.Contains(err.Error(), "invalid") {
		t.Fatal(err)
	}
}

func TestHeldBackAliasDeliveredLater(t *testing.T) {
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	req := deliveryRequest()
	req.Candidates[0].Action = "held-back"
	first, err := h.CheckAndMark(req)
	if err != nil {
		t.Fatal(err)
	}
	req.Aliases = map[string]string{"mx_abcdef": "mx_ghijkl"}
	req.Candidates[0].EntryID = "mx_ghijkl"
	req.Candidates[0].Action = "given"
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	var n int
	if err = h.db.QueryRow("SELECT count(*) FROM followups WHERE delivery_id=? AND kind='delivered-later'", first.Receipts[0].ID).Scan(&n); err != nil || n != 1 {
		t.Fatal(n, err)
	}
}
