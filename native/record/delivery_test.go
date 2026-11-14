package record

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func deliveryRequest() DeliveryRequest {
	return DeliveryRequest{Session: Session{SessionID: "s", Agent: "test", ProjectID: "project", Checkout: "/repo"}, Budget: 2000, Now: time.Date(2026, 11, 14, 0, 0, 0, 0, time.UTC), Candidates: []DeliveryCandidate{{EntryID: "mx_abcdef", Moment: "read", Form: "full", Tokens: 100, ContentHash: "hash"}}}
}
func TestDeliveryMigrationFromOne(t *testing.T) {
	l := testLocation(t)
	db, err := openDatabase(l.Hooks, false)
	if err != nil {
		t.Fatal(err)
	}
	schema, _ := schemas.ReadFile("schema/hooks/0001_init.sql")
	if _, err = db.Exec(string(schema) + `; PRAGMA user_version=1; INSERT INTO sessions VALUES('kept','test','p','/repo','old','old',0); INSERT INTO epochs VALUES('kept','',0,'old',9); INSERT INTO deliveries VALUES('old','kept','',0,'old','read','e','full',9,'given');`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	h, err := openHooks(l, testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	var budget, tokens int
	var reason, hash, block string
	if err = h.db.QueryRow(`SELECT budget,tokens_sent,reason FROM epochs WHERE session_id='kept'`).Scan(&budget, &tokens, &reason); err != nil || budget != 2000 || tokens != 9 || reason != "startup" {
		t.Fatalf("migration %d %d %s %v", budget, tokens, reason, err)
	}
	if err = h.db.QueryRow(`SELECT content_hash,block_id FROM deliveries WHERE id='old'`).Scan(&hash, &block); err != nil || hash != "" || block != "" {
		t.Fatal(err, hash, block)
	}
	h.Close()
	h, err = openHooks(l, testBudget)
	if err != nil {
		t.Fatal(err)
	}
	h.Close()
}
func TestDeliveryLifecycle(t *testing.T) {
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	req := deliveryRequest()
	req.Candidates = nil
	for _, tc := range []struct {
		reason        string
		signal, epoch int
		agent         string
	}{
		{"startup", 0, 0, ""}, {"startup", 0, 0, ""}, {"resume", 0, 0, ""}, {"compact", 2, 1, ""}, {"compact", 1, 1, ""}, {"compact", 2, 2, ""}, {"compact", 1, 2, ""}, {"clear", 0, 3, ""}, {"fork", 0, 4, ""}, {"subagent", 0, 0, "child"}, {"subagent", 0, 0, "child"}, {"resume", 0, 4, ""},
	} {
		req.Reason = tc.reason
		req.CompactSignal = tc.signal
		req.AgentID = tc.agent
		r, err := h.CheckAndMark(req)
		if err != nil || r.Epoch.Number != tc.epoch {
			t.Fatalf("%+v got %+v: %v", tc, r, err)
		}
	}
}
func TestDeliveryAtomicBudgetAliasesAndIsolation(t *testing.T) {
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	req := deliveryRequest()
	req.Budget = 150
	r, err := h.CheckAndMark(req)
	if err != nil || len(r.Receipts) != 1 || r.Epoch.TokensSent != 100 || r.Receipts[0].ID == "" || r.Receipts[0].BlockID == "" {
		t.Fatal(r, err)
	}
	req.Aliases = map[string]string{"mx_abcdef": "mx_ghijkl"}
	req.Candidates[0].EntryID = "mx_ghijkl"
	r, err = h.CheckAndMark(req)
	if err != nil || len(r.Receipts) != 0 {
		t.Fatal(r, err)
	}
	req.Candidates[0].EntryID = "mx_mnopqr"
	r, err = h.CheckAndMark(req)
	if err != nil || r.Receipts[0].Action != "held-back" || r.Epoch.TokensSent != 100 {
		t.Fatal(r, err)
	}
	req.Candidates[0].Reserved = true
	r, err = h.CheckAndMark(req)
	if err != nil || r.Receipts[0].Action != "given" || r.Epoch.ReservedTokens != 100 {
		t.Fatal(r, err)
	}
	req.Session.SessionID = "second"
	r, err = h.CheckAndMark(req)
	if err != nil || len(r.Receipts) != 1 {
		t.Fatal(r, err)
	}
	req.Session.Checkout = "/other"
	req.Candidates[0].Reserved = false
	r, err = h.CheckAndMark(req)
	if err != nil || len(r.Receipts) != 1 {
		t.Fatal(r, err)
	}
	// A malformed later candidate must roll back the earlier receipt and cost.
	req.Session.SessionID = "rollback"
	req.Aliases = nil
	req.Candidates = append(req.Candidates, DeliveryCandidate{EntryID: "bad", Form: "invalid"})
	if _, err = h.CheckAndMark(req); err == nil {
		t.Fatal("accepted invalid form")
	}
	var n int
	h.db.QueryRow(`SELECT count(*) FROM sessions WHERE session_id='rollback'`).Scan(&n)
	if n != 0 {
		t.Fatal("partial session survived")
	}
	req = deliveryRequest()
	req.Session.Agent = "other"
	if _, err = h.CheckAndMark(req); err == nil {
		t.Fatal("foreign agent accepted")
	}
	req = deliveryRequest()
	req.Session.SessionID = "s\x00other"
	if _, err = h.CheckAndMark(req); err == nil {
		t.Fatal("NUL identity accepted")
	}
	req = deliveryRequest()
	h.db.Exec(`UPDATE sessions SET paused=1 WHERE session_id='s'`)
	if _, err = h.CheckAndMark(req); err == nil {
		t.Fatal("paused session accepted")
	}
}
func TestDeliveryPruneBounds(t *testing.T) {
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	req := deliveryRequest()
	req.Now = req.Now.Add(-60 * 24 * time.Hour)
	req.Candidates = nil
	for i := 0; i < 700; i++ {
		req.Candidates = append(req.Candidates, DeliveryCandidate{EntryID: fmt.Sprintf("entry-%d", i), Moment: "read", Form: "full", Tokens: 1, Exempt: true})
	}
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	h.db.Exec(`INSERT INTO followups(delivery_id,ts,kind) SELECT id,ts,'opened' FROM deliveries`)
	req = deliveryRequest()
	req.Session.SessionID = "current"
	req.Reason = "startup"
	req.Candidates = nil
	req.KeepSession = func(agent, id string) bool { return true }
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	var kept int
	h.db.QueryRow(`SELECT count(*) FROM deliveries`).Scan(&kept)
	if kept != 700 {
		t.Fatal("pruned a file-heartbeat session")
	}
	req.KeepSession = nil
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	var d, f int
	h.db.QueryRow(`SELECT count(*) FROM deliveries`).Scan(&d)
	h.db.QueryRow(`SELECT count(*) FROM followups`).Scan(&f)
	if d != 444 || f != 444 {
		t.Fatalf("pruned unbounded or nothing: %d deliveries %d followups", d, f)
	}
	// Active sessions' old epochs are retained.
	h.db.Exec(`UPDATE sessions SET last_seen_at=? WHERE session_id='s'`, req.Now.UTC().Format(time.RFC3339Nano))
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	h.db.QueryRow(`SELECT count(*) FROM deliveries`).Scan(&d)
	if d != 444 {
		t.Fatal("pruned live context")
	}
}
func TestDeliveryRealProcesses(t *testing.T) {
	l := testLocation(t)
	h, err := openHooks(l, testBudget)
	if err != nil {
		t.Fatal(err)
	}
	h.Close()
	exe, _ := os.Executable()
	barrier := t.TempDir()
	type peer struct {
		cmd *exec.Cmd
		out *bytes.Buffer
	}
	peers := []peer{}
	for i := 0; i < 8; i++ {
		cmd := exec.Command(exe, "-test.run=^TestDeliveryProcess$", "-test.timeout=30s")
		cmd.Env = append(os.Environ(), "MEX_DELIVERY_TEST_DB="+l.Hooks, "MEX_DELIVERY_TEST_BARRIER="+barrier, fmt.Sprintf("MEX_DELIVERY_TEST_PEER=%d", i))
		out := &bytes.Buffer{}
		cmd.Stdout = out
		cmd.Stderr = out
		if err = cmd.Start(); err != nil {
			t.Fatal(err)
		}
		peers = append(peers, peer{cmd, out})
		t.Cleanup(func() {
			if cmd.ProcessState == nil {
				_ = cmd.Process.Kill()
			}
		})
	}
	for i := range peers {
		waitFile(t, filepath.Join(barrier, fmt.Sprintf("ready-%d", i)))
	}
	os.WriteFile(filepath.Join(barrier, "start"), nil, 0600)
	for _, p := range peers {
		if err = p.cmd.Wait(); err != nil {
			t.Fatalf("%v: %s", err, p.out)
		}
	}
	h, err = openHooks(l, testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	var n, tokens int
	h.db.QueryRow(`SELECT count(*) FROM deliveries WHERE action='given'`).Scan(&n)
	h.db.QueryRow(`SELECT sum(tokens_sent) FROM epochs`).Scan(&tokens)
	if n != 2 || tokens != 200 {
		t.Fatalf("gave %d cost %d, want one per session", n, tokens)
	}
}
func TestDeliveryProcess(t *testing.T) {
	path := os.Getenv("MEX_DELIVERY_TEST_DB")
	if path == "" {
		return
	}
	h, err := openHooks(Location{Hooks: path}, testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	barrier := os.Getenv("MEX_DELIVERY_TEST_BARRIER")
	name := os.Getenv("MEX_DELIVERY_TEST_PEER")
	os.WriteFile(filepath.Join(barrier, "ready-"+name), nil, 0600)
	waitFile(t, filepath.Join(barrier, "start"))
	req := deliveryRequest()
	if name >= "4" {
		req.Session.SessionID = "second"
	}
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
}
func TestDeliveryBusyFailsOpen(t *testing.T) {
	l := testLocation(t)
	h, err := OpenHooks(l)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	lock, err := OpenHooks(l)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	lock.db.Exec("BEGIN IMMEDIATE")
	defer lock.db.Exec("ROLLBACK")
	start := time.Now()
	_, err = h.CheckAndMark(deliveryRequest())
	if err == nil {
		t.Fatal("wrote through lock")
	}
	if elapsed := time.Since(start); elapsed > WriterOperationTimeout+100*time.Millisecond {
		t.Fatalf("lock exceeded bound: %s", elapsed)
	}
	var n int
	if err = h.db.QueryRowContext(context.Background(), `SELECT count(*) FROM deliveries`).Scan(&n); err != nil || n != 0 {
		t.Fatal(n, err)
	}
}
