package record

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
)

func TestSurfaceConcurrentShadowClaim(t *testing.T) {
	loc := testLocation(t)
	initial, err := openHooks(loc, testBudget)
	if err != nil {
		t.Fatal(err)
	}
	initial.Close()
	var count atomic.Int32
	var wg sync.WaitGroup
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			h, err := openHooks(loc, testBudget)
			if err != nil {
				t.Error(err)
				return
			}
			defer h.Close()
			req := deliveryRequest()
			req.Candidates[0].Mode = "shadow"
			req.Candidates[0].Target = SurfaceTarget{Scopes: []string{"src/**"}}
			result, err := h.CheckAndMark(req)
			if err != nil {
				t.Error(err)
				return
			}
			count.Add(int32(len(result.Receipts)))
		}()
	}
	wg.Wait()
	if count.Load() != 1 {
		t.Fatalf("parallel receipts %d", count.Load())
	}
	h, err := openHooks(loc, testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	var windows, firings int
	if err = h.db.QueryRow(`SELECT count(*) FROM surface_windows`).Scan(&windows); err != nil {
		t.Fatal(err)
	}
	if err = h.db.QueryRow(`SELECT sum(firings) FROM surface_stats`).Scan(&firings); err != nil {
		t.Fatal(err)
	}
	if windows != 1 || firings != 1 {
		t.Fatal(windows, firings)
	}
}

func TestSurfaceItemsInOneFiringAreAllFirst(t *testing.T) {
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	req := deliveryRequest()
	req.Candidates[0].Target = SurfaceTarget{Scopes: []string{"src/**"}, Paths: []string{"src/a.go"}}
	other := req.Candidates[0]
	other.EntryID = "other"
	other.Target = SurfaceTarget{Scopes: []string{"other/**"}, Paths: []string{"other/b.go"}}
	req.Candidates = append(req.Candidates, other)
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	var repeated int
	if err = h.db.QueryRow(`SELECT sum(repeated) FROM surface_windows`).Scan(&repeated); err != nil || repeated != 0 {
		t.Fatal(repeated, err)
	}
	var firings, receipts int
	if err = h.db.QueryRow(`SELECT firings,receipts FROM surface_stats`).Scan(&firings, &receipts); err != nil || firings != 1 || receipts != 2 {
		t.Fatal(firings, receipts, err)
	}
	req.Candidates = nil
	req.SurfaceTools = []SurfaceTool{{Paths: []string{"src/a.go"}, Edit: true, Success: true, Added: "safe"}}
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	var pendingSettled int
	if err = h.db.QueryRow(`SELECT settled FROM surface_stats`).Scan(&pendingSettled); err != nil || pendingSettled != 0 {
		t.Fatal("settled before the other window", pendingSettled, err)
	}
	req.SurfaceTools = nil
	req.EndEpoch = true
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	var settled int
	if err = h.db.QueryRow(`SELECT settled FROM surface_stats`).Scan(&settled); err != nil || settled != 1 {
		t.Fatal(settled, err)
	}
	var acted int
	if err = h.db.QueryRow(`SELECT acted FROM surface_stats`).Scan(&acted); err != nil || acted != 1 {
		t.Fatal(acted, err)
	}
}

func TestSurfaceBatchObservesEachCheckoutWithoutDoubleCounting(t *testing.T) {
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	req := deliveryRequest()
	req.Candidates[0].Moment = "prompt"
	req.Candidates[0].Target = SurfaceTarget{Scopes: []string{"src/**"}}
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	req.Candidates = nil
	req.Session.ProjectID = "other"
	req.Session.Checkout = "/other"
	req.SurfaceTools = []SurfaceTool{{Scoped: map[string]SurfaceTool{
		"project\n/repo": {Paths: []string{"src/a.go"}, Open: true, Success: true},
		"other\n/other":  {Paths: []string{"src/b.go"}, Open: true, Success: true},
	}}}
	result, err := h.CheckAndMark(req)
	if err != nil || result.Epoch.ToolCalls != 1 {
		t.Fatal(result, err)
	}
	req.SurfaceTools = nil
	req.EndEpoch = true
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	var acted int
	if err = h.db.QueryRow(`SELECT acted FROM surface_windows`).Scan(&acted); err != nil || acted != 1 {
		t.Fatal(acted, err)
	}
}

func TestSurfaceMigrationPreservesDependentRows(t *testing.T) {
	loc := testLocation(t)
	db, err := openDatabase(loc.Hooks, false)
	if err != nil {
		t.Fatal(err)
	}
	var steps []migration
	for i, name := range []string{"0001_init.sql", "0002_delivery.sql", "0003_followups.sql", "0004_rendering.sql", "0005_probes.sql", "0006_intent.sql"} {
		b, err := schemas.ReadFile("schema/hooks/" + name)
		if err != nil {
			t.Fatal(err)
		}
		steps = append(steps, migration{i + 1, string(b)})
	}
	if err = migrate(context.Background(), db, steps); err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`INSERT INTO sessions VALUES('s','codex','p','/repo','old','old',0);
 INSERT INTO epochs(session_id,epoch,started_at) VALUES('s',0,'old');
 INSERT INTO deliveries(id,session_id,epoch,ts,moment,entry_id,form,tokens,action,content_hash,block_id) VALUES('r','s',0,'old','read','mx_abcdef','full',12,'given','hash','block');
 INSERT INTO followups(delivery_id,ts,kind) VALUES('r','later','followed');
 INSERT INTO delivery_touches VALUES('r');`)
	if err != nil {
		t.Fatal(err)
	}
	db.Close()
	h, err := openHooks(loc, testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	var surface, hash, block, kind string
	if err = h.db.QueryRow(`SELECT d.surface,d.content_hash,d.block_id,f.kind FROM deliveries d JOIN followups f ON f.delivery_id=d.id JOIN delivery_touches t ON t.delivery_id=d.id WHERE d.id='r'`).Scan(&surface, &hash, &block, &kind); err != nil || surface != "read-pitfall" || hash != "hash" || block != "block" || kind != "followed" {
		t.Fatal(surface, hash, block, kind, err)
	}
	rows, err := h.db.Query(`PRAGMA foreign_key_check`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	if rows.Next() {
		t.Fatal("migration broke a foreign key")
	}
}

func TestEmptyHooksInitializationIsAtomic(t *testing.T) {
	loc := testLocation(t)
	db, err := openDatabase(loc.Hooks, false)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var steps []migration
	for i, name := range []string{"0001_init.sql", "0002_delivery.sql", "0003_followups.sql", "0004_rendering.sql", "0005_probes.sql", "0006_intent.sql", "0007_surfaces.sql"} {
		data, err := schemas.ReadFile("schema/hooks/" + name)
		if err != nil {
			t.Fatal(err)
		}
		steps = append(steps, migration{i + 1, string(data)})
	}
	broken := append([]migration{}, steps...)
	broken[len(broken)-1].sql = "INVALID INITIAL SCHEMA"
	if _, err = initializeEmptyHooks(context.Background(), db, broken); err == nil {
		t.Fatal("accepted failed initialization")
	}
	version, err := schemaVersion(context.Background(), db)
	if err != nil || version != 0 {
		t.Fatal(version, err)
	}
	var tables int
	if err = db.QueryRow(`SELECT count(*) FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'`).Scan(&tables); err != nil || tables != 0 {
		t.Fatal("partial initial schema", tables, err)
	}
	initialized, err := initializeEmptyHooks(context.Background(), db, steps)
	if err != nil || !initialized {
		t.Fatal(initialized, err)
	}
	version, err = schemaVersion(context.Background(), db)
	if err != nil || version != SchemaVersion {
		t.Fatal(version, err)
	}
}

func TestSurfaceNoticeWaitsForCapableEvent(t *testing.T) {
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	req := deliveryRequest()
	req.Candidates[0].Target = SurfaceTarget{Scopes: []string{"src/**"}}
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	if _, err = h.db.Exec(`UPDATE surface_gates SET state='off',failures=2`); err != nil {
		t.Fatal(err)
	}
	req.Candidates = nil
	req.EndEpoch = true
	result, err := h.CheckAndMark(req)
	if err != nil || len(result.Notices) != 0 {
		t.Fatal(result, err)
	}
	var announced int
	if err = h.db.QueryRow(`SELECT announced FROM surface_gates`).Scan(&announced); err != nil || announced != 0 {
		t.Fatal(announced, err)
	}
	req.EndEpoch = false
	req.Reason = "resume"
	req.Notify = true
	result, err = h.CheckAndMark(req)
	if err != nil || len(result.Notices) != 1 {
		t.Fatal(result, err)
	}
	result, err = h.CheckAndMark(req)
	if err != nil || len(result.Notices) != 0 {
		t.Fatal(result, err)
	}
}

func TestSurfaceHintSurvivesRollbackAndRacingCleanup(t *testing.T) {
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	req := deliveryRequest()
	req.Candidates[0].Moment = "prompt"
	req.Candidates[0].Target = SurfaceTarget{Scopes: []string{"src/**"}}
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	conn, err := h.db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err = conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		t.Fatal(err)
	}
	if _, err = conn.ExecContext(ctx, `UPDATE surface_windows SET settled=1`); err != nil {
		t.Fatal(err)
	}
	cleanup, err := h.syncSurfacePending(ctx, conn, req)
	if err != nil {
		t.Fatal(err)
	}
	if !SurfacePending(h.directory, req.Session.SessionID, req.AgentID) {
		t.Fatal("uncommitted close hid pending window")
	}
	if _, err = conn.ExecContext(ctx, "ROLLBACK"); err != nil {
		t.Fatal(err)
	}
	cleanup(false)
	if !SurfacePending(h.directory, req.Session.SessionID, req.AgentID) {
		t.Fatal("rollback lost hint")
	}
	// The directory itself is the hint. A crash leaves a retiring marker, and
	// another creator's active marker prevents post-commit removal of the directory.
	if _, err = conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		t.Fatal(err)
	}
	if _, err = conn.ExecContext(ctx, `UPDATE surface_windows SET settled=1`); err != nil {
		t.Fatal(err)
	}
	cleanup, err = h.syncSurfacePending(ctx, conn, req)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = conn.ExecContext(ctx, "COMMIT"); err != nil {
		t.Fatal(err)
	}
	dir := surfacePendingPath(h.directory, req.Session.SessionID, req.AgentID)
	if err = os.WriteFile(filepath.Join(dir, "active"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	cleanup(true)
	if !SurfacePending(h.directory, req.Session.SessionID, req.AgentID) {
		t.Fatal("cleanup removed a racing creator's hint")
	}
}

func TestSurfaceActedDefinitions(t *testing.T) {
	target := SurfaceTarget{Scopes: []string{"src/**"}, Commands: []string{"exact"}, Failure: "failed", Anti: []string{"unsafe("}}
	edit := SurfaceTool{Paths: []string{"src/a.go"}, Edit: true, Success: true, Added: "safe()"}
	open := SurfaceTool{Paths: []string{"src/a.go"}, Open: true, Success: true}
	for _, test := range []struct {
		name, surface string
		target        SurfaceTarget
		tool          SurfaceTool
		want          bool
	}{
		{"exact recipe", "command-recipe", target, SurfaceTool{Command: "exact", Success: true}, true},
		{"recipe near match", "command-recipe", target, SurfaceTool{Command: "exact --extra", Success: true}, false},
		{"failed recipe still ran", "command-recipe", target, SurfaceTool{Command: "exact", Success: false}, true},
		{"fix command", "failure-fix", target, SurfaceTool{Command: "exact", Success: true}, true},
		{"failed fix command still ran", "failure-fix", target, SurfaceTool{Command: "exact", Success: false}, true},
		{"successful rerun", "failure-fix", target, SurfaceTool{Command: "failed", Success: true}, true},
		{"unsafe rerun", "failure-fix", target, SurfaceTool{Command: "failed"}, false},
		{"pitfall avoids literal", "read-pitfall", target, edit, true},
		{"risk avoids literal", "read-risk", target, edit, true},
		{"edit avoids literal", "edit", target, edit, true},
		{"unsafe edit", "read-risk", target, SurfaceTool{Paths: edit.Paths, Edit: true, Success: true, Added: "unsafe()"}, false},
		{"outside edit", "edit", target, SurfaceTool{Paths: []string{"other/a.go"}, Edit: true, Success: true, Added: "safe()"}, false},
		{"unknown edit text", "edit", target, SurfaceTool{Paths: edit.Paths, Edit: true, Success: true}, false},
		{"named file", "read-pitfall", SurfaceTarget{Paths: edit.Paths}, edit, true},
		{"different named file does not excuse unsafe edit", "read-risk", SurfaceTarget{Scopes: []string{"src/**"}, Paths: []string{"src/named.go"}, Anti: []string{"unsafe("}}, SurfaceTool{Paths: edit.Paths, Edit: true, Success: true, Added: "unsafe()"}, false},
		{"read is not edit", "read-risk", target, open, false},
		{"prompt scope", "prompt", target, open, true},
		{"prompt needs scope even with another named file", "prompt", SurfaceTarget{Scopes: []string{"other/**"}, Paths: open.Paths}, open, false},
		{"start scope", "start-brief", target, open, true},
		{"previous scope", "start-brief-previous", target, open, true},
		{"recovery scope", "recovery", target, open, true},
		{"history scope", "bug-history", target, edit, true},
		{"rescue path", "rescue-wrong-path", SurfaceTarget{Paths: open.Paths}, open, true},
		{"rescue symbol", "rescue-search", SurfaceTarget{Names: []string{"LoadRecord"}}, SurfaceTool{Names: []string{"LoadRecord"}, Success: true}, true},
		{"wide path", "rescue-wide", SurfaceTarget{Paths: open.Paths}, open, true},
		{"glob path", "rescue-glob-timeout", SurfaceTarget{Paths: open.Paths}, open, true},
		{"unknown surface", "unknown", target, open, false},
		{"card requires replacement evidence", "graph-card", target, open, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := Acted(test.surface, test.target, test.tool); got != test.want {
				t.Fatalf("acted=%v want %v", got, test.want)
			}
		})
	}
}

func TestSurfaceMomentVocabulary(t *testing.T) {
	for _, moment := range []string{"read", "read-risk", "edit", "rejected", "create", "command", "failure", "prompt", "start-brief", "recovery", "resume", "subagent", "brief", "correction", "companion"} {
		if id := SurfaceForMoment(moment); id == "unknown" || !ValidSurface(id) {
			t.Fatal(moment, id)
		}
	}
	if SurfaceForMoment("historical-unmapped") != "unknown" {
		t.Fatal("missing historical fallback")
	}
}

func TestShadowReceiptBytesAndBudgetMatchLive(t *testing.T) {
	var receipts [][]byte
	var epochs []Epoch
	for _, mode := range []string{"on", "shadow"} {
		h, err := openHooks(testLocation(t), testBudget)
		if err != nil {
			t.Fatal(err)
		}
		defer h.Close()
		n := 0
		h.newID = func() (string, error) { n++; return fmt.Sprintf("id-%d", n), nil }
		req := deliveryRequest()
		req.SurfaceMode = func(string) string { return mode }
		req.Candidates[0].Target = SurfaceTarget{Scopes: []string{"src/**"}, Anti: []string{"bad"}}
		result, err := h.CheckAndMark(req)
		if err != nil {
			t.Fatal(err)
		}
		if len(result.Receipts) != 1 {
			t.Fatal(result)
		}
		r := result.Receipts[0]
		if mode == "shadow" {
			if r.Action != "shadow" {
				t.Fatal(r)
			}
			r.Action = "given"
		}
		b, _ := json.Marshal(r)
		receipts = append(receipts, b)
		epochs = append(epochs, result.Epoch)
		again, err := h.CheckAndMark(req)
		if err != nil || len(again.Receipts) != 0 {
			t.Fatal(again, err)
		}
	}
	if !bytes.Equal(receipts[0], receipts[1]) {
		t.Fatalf("live %s\nshadow %s", receipts[0], receipts[1])
	}
	if !reflect.DeepEqual(epochs[0], epochs[1]) {
		t.Fatal(epochs)
	}
}

func TestSurfaceFortyCallsAndEpochEnd(t *testing.T) {
	for _, at := range []int{1, 40, 41} {
		t.Run(fmt.Sprint(at), func(t *testing.T) {
			h, err := openHooks(testLocation(t), testBudget)
			if err != nil {
				t.Fatal(err)
			}
			defer h.Close()
			req := deliveryRequest()
			req.Candidates[0].Moment = "prompt"
			req.Candidates[0].Target = SurfaceTarget{Scopes: []string{"src/**"}}
			if _, err = h.CheckAndMark(req); err != nil {
				t.Fatal(err)
			}
			if !SurfacePending(h.directory, req.Session.SessionID, req.AgentID) {
				t.Fatal("missing presence hint")
			}
			req.Candidates = nil
			for call := 1; call <= 41; call++ {
				tool := SurfaceTool{}
				if call == at {
					tool = SurfaceTool{Paths: []string{"src/a.go"}, Open: true, Success: true}
				}
				req.SurfaceTools = []SurfaceTool{tool}
				if _, err = h.CheckAndMark(req); err != nil {
					t.Fatal(err)
				}
			}
			var acted, settled int
			if err = h.db.QueryRow(`SELECT acted,settled FROM surface_windows`).Scan(&acted, &settled); err != nil {
				t.Fatal(err)
			}
			want := 1
			if at == 41 {
				want = 0
			}
			if acted != want || settled != 1 {
				t.Fatalf("acted %d settled %d", acted, settled)
			}
			if SurfacePending(h.directory, req.Session.SessionID, req.AgentID) {
				t.Fatal("expired presence hint")
			}
		})
	}
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	req := deliveryRequest()
	req.Candidates[0].Target = SurfaceTarget{Scopes: []string{"src/**"}, Anti: []string{"bad"}}
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	req.Candidates = nil
	req.SurfaceTools = []SurfaceTool{{Paths: []string{"src/a.go"}, Edit: true, Success: true, Added: "bad"}, {Paths: []string{"src/a.go"}, Edit: true, Success: true, Added: "safe"}}
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	var acted, settled int
	_ = h.db.QueryRow(`SELECT acted,settled FROM surface_windows`).Scan(&acted, &settled)
	if acted != 0 || settled != 1 {
		t.Fatal("later edit rewrote first-edit outcome", acted, settled)
	}
	req.Reason = "compact"
	req.CompactSignal = 1
	req.SurfaceTools = nil
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
}

func TestSurfaceSessionAgentAndCheckoutIsolation(t *testing.T) {
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	req := deliveryRequest()
	req.Candidates[0].Moment = "prompt"
	req.Candidates[0].Target = SurfaceTarget{Scopes: []string{"src/**"}}
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*DeliveryRequest){func(r *DeliveryRequest) { r.AgentID = "other" }, func(r *DeliveryRequest) { r.Session.SessionID = "other" }, func(r *DeliveryRequest) { r.Session.Checkout = "/other" }, func(r *DeliveryRequest) { r.Session.ProjectID = "other" }} {
		r := req
		r.Candidates = nil
		change(&r)
		r.SurfaceTools = []SurfaceTool{{Paths: []string{"src/a.go"}, Open: true, Success: true}}
		if _, err = h.CheckAndMark(r); err != nil {
			t.Fatal(err)
		}
	}
	req.Candidates = nil
	req.EndEpoch = true
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	var acted, settled int
	_ = h.db.QueryRow(`SELECT acted,settled FROM surface_windows`).Scan(&acted, &settled)
	if acted != 0 || settled != 1 {
		t.Fatal(acted, settled)
	}
}

func TestSurfaceGateAndWilson(t *testing.T) {
	for _, test := range []struct {
		n, yes, first, fa, repeat, ra, base, ba int
		want                                    string
	}{
		{29, 29, 10, 10, 19, 19, 30, 0, "collecting"}, {30, 30, 30, 30, 0, 0, 30, 0, "collecting"},
		{30, 30, 15, 15, 15, 15, 0, 0, "collecting"}, {30, 8, 15, 4, 15, 4, 30, 0, "fail"},
		{30, 0, 30, 0, 0, 0, 30, 0, "fail"},
		{30, 12, 15, 6, 15, 6, 30, 9, "fail"}, {30, 21, 15, 12, 15, 9, 30, 0, "fail"},
		{30, 24, 15, 12, 15, 12, 30, 3, "pass"},
	} {
		state, _ := GateDecision(test.n, test.yes, test.first, test.fa, test.repeat, test.ra, test.base, test.ba)
		if state != test.want {
			t.Fatal(test, state)
		}
	}
	if got := WilsonLower(15, 30, 1.959963984540054); got < .331 || got > .333 {
		t.Fatal(got)
	}
}

func TestSurfaceRollupsAndTwoFreshGateFailures(t *testing.T) {
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	req := deliveryRequest()
	req.Notify = true
	req.Candidates[0].Moment = "prompt"
	req.Candidates[0].Target = SurfaceTarget{Scopes: []string{"src/**"}}
	// Six sessions, ten receipts each; each session has first and repeat firings.
	for batch := 0; batch < 2; batch++ {
		for session := 0; session < 3; session++ {
			req.Session.SessionID = fmt.Sprintf("s-%d-%d", batch, session)
			for i := 0; i < 10; i++ {
				req.Candidates[0].EntryID = fmt.Sprintf("entry-%d", i)
				if _, err = h.CheckAndMark(req); err != nil {
					t.Fatal(err)
				}
			}
			// A real held-back baseline, with the same target and zero acted outcome.
			hold := req
			hold.Candidates = append([]DeliveryCandidate{}, req.Candidates...)
			hold.Candidates[0].EntryID = "held"
			hold.Candidates[0].Action = "held-back"
			if _, err = h.CheckAndMark(hold); err != nil {
				t.Fatal(err)
			}
			end := req
			end.Candidates = nil
			end.EndEpoch = true
			result, err := h.CheckAndMark(end)
			if err != nil {
				t.Fatal(err)
			}
			if len(result.Notices) > 0 && (batch != 1 || session != 2 || len(result.Notices) != 1) {
				t.Fatal(result.Notices)
			}
		}
		var state string
		var failures int
		_ = h.db.QueryRow(`SELECT state,failures FROM surface_gates WHERE surface='prompt'`).Scan(&state, &failures)
		if failures != batch+1 || (batch == 0 && state != "fail") || (batch == 1 && state != "off") {
			t.Fatal(state, failures)
		}
	}
	req.Session.SessionID = "after-off"
	result, err := h.CheckAndMark(req)
	if err != nil || len(result.Receipts) > 0 {
		t.Fatal(result, err)
	}
	report, err := ReadSurfaces(h.pathForTest(t), req.Session.ProjectID, req.Session.Checkout)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range report.Surfaces {
		if s.Surface == "prompt" {
			if s.Live.Firings != 60 || s.First.Firings != 6 || s.Repeat.Firings != 54 || s.HeldBack.Settled != 6 || s.BaseKind != "held-back" || s.BaseRate == nil || *s.BaseRate != 0 || s.FalseSendEstimate != 60 || s.Gate != "off" {
				t.Fatalf("%+v", s)
			}
		}
	}
	ctx := context.Background()
	conn, err := h.db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	notices, err := evaluateSurfaceGates(ctx, conn, req.Session.ProjectID)
	if err != nil || len(notices) > 0 {
		t.Fatal(notices, err)
	}
}
