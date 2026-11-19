package record

import "testing"

func TestFalseSendDailyCountsClaimClosureOnce(t *testing.T) {
	for _, offline := range []bool{false, true} {
		h, err := openHooks(testLocation(t), testBudget)
		if err != nil {
			t.Fatal(err)
		}
		req := deliveryRequest()
		req.Session.Agent = "codex"
		req.Offline = offline
		first, err := h.CheckAndMark(req)
		if err != nil {
			t.Fatal(err)
		}
		req.Candidates[0].EntryID = "mx_unobserved"
		if _, err = h.CheckAndMark(req); err != nil {
			t.Fatal(err)
		}
		req.Candidates = nil
		req.Touches = []string{first.Receipts[0].ID}
		req.EndEpoch = true
		if _, err = h.CheckAndMark(req); err != nil {
			t.Fatal(err)
		}
		if _, err = h.CheckAndMark(req); err != nil {
			t.Fatal(err)
		}
		var empty, total int
		h.db.QueryRow(`SELECT coalesce(sum(value),0) FROM counters_go WHERE name='agent:codex:knowledge.false_send_estimate'`).Scan(&empty)
		h.db.QueryRow(`SELECT coalesce(sum(value),0) FROM counters_go WHERE name='agent:codex:knowledge.closed_deliveries'`).Scan(&total)
		if offline {
			if empty != 0 || total != 0 {
				t.Fatal(empty, total)
			}
		} else if empty != 1 || total != 2 {
			t.Fatal(empty, total)
		}
		h.Close()
	}
}
