package record

import (
	"context"
	"fmt"
	"testing"
)

func TestQuarterBudgetLanesSkipLargeAndDoNotStarve(t *testing.T) {
	for rotation := 0; rotation < 5; rotation++ {
		h, err := openHooks(testLocation(t), testBudget)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { h.Close() })
		req := deliveryRequest()
		req.Lanes = true
		req.SurfaceMode = func(string) string { return "on" }
		req.Budget = 500
		req.Candidates = nil
		surfaces := []string{"search-span", "prompt-anchor", "start-brief", "command-recipe", "failure-fix"}
		for i := 0; i < 5; i++ {
			surface := surfaces[(i+rotation)%5]
			c := DeliveryCandidate{EntryID: fmt.Sprintf("big-%s", surface), Surface: surface, Moment: surface, Form: "full", Tokens: 20, Exempt: surface == "failure-fix"}
			lane := LaneFor(c)
			c.Tokens = LaneLimit(lane, req.Budget) + 1
			req.Candidates = append(req.Candidates, c)
			c.EntryID = "small-" + surface
			c.Tokens = 20
			req.Candidates = append(req.Candidates, c)
		}
		res, err := h.CheckAndMark(req)
		if err != nil {
			t.Fatal(err)
		}
		sent := map[string]int{}
		for _, r := range res.Receipts {
			if r.Action == "given" {
				sent[r.Lane]++
			}
		}
		for _, lane := range []string{"cards", "prompt", "brief", "main", "critical"} {
			if sent[lane] == 0 {
				t.Fatalf("rotation %d starved %s: %+v", rotation, lane, res.Receipts)
			}
		}
		report, err := readLaneContention(context.Background(), h.db, req.Session.ProjectID, req.Session.Checkout)
		if err != nil || len(report) != 5 {
			t.Fatal(report, err)
		}
		for _, l := range report {
			if l.Lane != "critical" && (l.Admitted > l.Capacity || l.Held != 1) {
				t.Fatal(l)
			}
		}
		h.Close()
	}
}

func TestCardSurfacesShareSubcapAndEpochIsolation(t *testing.T) {
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	req := deliveryRequest()
	req.Lanes = true
	req.SurfaceMode = func(string) string { return "on" }
	req.Budget = 500
	req.Candidates[0].Surface = "search-span"
	req.Candidates[0].Tokens = 150
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	req.Candidates[0].Surface = "graph-card"
	req.Candidates[0].EntryID = "mx_graphslot"
	req.Candidates[0].Tokens = 60
	res, err := h.CheckAndMark(req)
	if err != nil || res.Receipts[0].Action != "held-back" {
		t.Fatal(res, err)
	}
	req.Reason = "clear"
	res, err = h.CheckAndMark(req)
	if err != nil || res.Receipts[0].Action != "given" {
		t.Fatal(res, err)
	}
}
