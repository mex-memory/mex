package record

import (
	"context"
	"fmt"
	"testing"
)

func TestSpanAvoidanceNeedsThreeCallsAndRecordsOtherLines(t *testing.T) {
	for _, kind := range []string{"avoid", "read-span", "other-lines", "short", "origin-batch"} {
		t.Run(kind, func(t *testing.T) {
			h, err := openHooks(testLocation(t), testBudget)
			if err != nil {
				t.Fatal(err)
			}
			defer h.Close()
			req := deliveryRequest()
			req.Candidates[0].Surface = "search-span"
			req.Candidates[0].Target = SurfaceTarget{Paths: []string{"src/a.ts"}, Start: 10, End: 15}
			if kind == "origin-batch" {
				req.Candidates[0].Target.Origin = "origin"
			}
			res, err := h.CheckAndMark(req)
			if err != nil {
				t.Fatal(err)
			}
			id := res.Receipts[0].ID
			req.Candidates = nil
			if kind == "origin-batch" {
				req.SurfaceTools = []SurfaceTool{{Key: "origin", Success: true}}
				if _, err = h.CheckAndMark(req); err != nil {
					t.Fatal(err)
				}
			}
			req.SurfaceTools = []SurfaceTool{{Success: true}, {Success: true}, {Success: true}}
			if kind == "short" {
				req.SurfaceTools = req.SurfaceTools[:2]
				req.EndEpoch = true
			}
			if kind == "read-span" {
				req.SurfaceTools[1] = SurfaceTool{Success: true, Open: true, Reads: []SurfaceRead{{"src/a.ts", 12, 14}}}
			}
			if kind == "other-lines" {
				req.SurfaceTools[1] = SurfaceTool{Success: true, Open: true, Reads: []SurfaceRead{{"src/a.ts", 40, 50}}}
			}
			if _, err = h.CheckAndMark(req); err != nil {
				t.Fatal(err)
			}
			var acted, harm, complete, observed int
			if err = h.db.QueryRow("SELECT acted,harm,complete,observed FROM surface_windows WHERE delivery_id=?", id).Scan(&acted, &harm, &complete, &observed); err != nil {
				t.Fatal(err)
			}
			wantActed := 1
			if kind == "read-span" || kind == "short" {
				wantActed = 0
			}
			wantHarm := 0
			if kind == "other-lines" {
				wantHarm = 1
			}
			if acted != wantActed || harm != wantHarm || complete != 1 && kind != "short" || observed != len(req.SurfaceTools) {
				t.Fatal(acted, harm, complete, observed)
			}
			if kind == "short" {
				var settled int
				h.db.QueryRow("SELECT sum(settled) FROM surface_stats").Scan(&settled)
				if complete != 0 || settled != 0 {
					t.Fatal("claimed short window", complete, settled)
				}
			}
		})
	}
}

func TestSpanKeepRuleRequiresCostSessions(t *testing.T) {
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	req := deliveryRequest()
	req.Candidates[0].Surface = "search-span"
	req.Candidates[0].Target = SurfaceTarget{Paths: []string{"src/a.ts"}, Start: 10, End: 15}
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	c, err := h.db.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	// Test the delta rule independently of the parent efficacy rule.
	state, _, err := additionalSurfaceGate(ctx, c, req.Session.ProjectID, "search-span", "shadow", 100, 50, 100, 30)
	if err != nil || state != "fail" {
		t.Fatal(state, err)
	}
	_, err = c.ExecContext(ctx, "UPDATE surface_gates SET no_harm_rise=0")
	if err != nil {
		t.Fatal(err)
	}
	state, _, err = additionalSurfaceGate(ctx, c, req.Session.ProjectID, "search-span", "shadow", 100, 80, 100, 30)
	if err != nil || state != "collecting" {
		t.Fatal(state, err)
	}
	// Agent contexts in one task do not constitute ten distinct sessions.
	for i := 0; i < 10; i++ {
		if _, err = c.ExecContext(ctx, "INSERT INTO surface_cost_checks VALUES(?,?,?,?,?)", req.Session.ProjectID, "search-span", "one-task", fmt.Sprint(i), 100); err != nil {
			t.Fatal(err)
		}
	}
	state, _, err = additionalSurfaceGate(ctx, c, req.Session.ProjectID, "search-span", "shadow", 100, 80, 100, 30)
	if err != nil || state != "collecting" {
		t.Fatal(state, err)
	}
	if _, err = c.ExecContext(ctx, "DELETE FROM surface_cost_checks"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 10; i++ {
		if _, err = c.ExecContext(ctx, "INSERT INTO surface_cost_checks VALUES(?,?,?,?,?)", req.Session.ProjectID, "search-span", fmt.Sprint(i), "", 100); err != nil {
			t.Fatal(err)
		}
	}
	state, _, err = additionalSurfaceGate(ctx, c, req.Session.ProjectID, "search-span", "shadow", 100, 80, 100, 30)
	if err != nil || state != "pass" {
		t.Fatal(state, err)
	}
}
