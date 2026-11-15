package record

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestAdviceEffectsKeepPerActionProofAndDoNotMergeAcrossTransitions(t *testing.T) {
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	req := deliveryRequest()
	req.Branch = "refs/heads/work"
	req.Head = strings.Repeat("a", 40)
	res, err := h.CheckAndMark(req)
	if err != nil {
		t.Fatal(err)
	}
	receipt := res.Receipts[0]
	req.Candidates = nil
	data, _ := json.Marshal(AdviceEffect{Version: 1, Key: strings.Repeat("b", 64), Summary: "ran a shell command (arguments omitted)"})
	req.Probes = []FollowupObservation{{ReceiptID: receipt.ID, EntryID: receipt.EntryID, Kind: "command", Detail: string(data)}}
	for _, verdict := range []string{"held", "held", "broken"} {
		if err = h.PutVerdicts(req.Session.ProjectID, req.Session.Checkout, []Verdict{{EntryID: receipt.EntryID, Verdict: verdict, InputsHash: "sha256:" + strings.Repeat(map[string]string{"held": "a", "broken": "b"}[verdict], 64), CheckedAt: "now"}}); err != nil {
			t.Fatal(err)
		}
		if _, err = h.CheckAndMark(req); err != nil {
			t.Fatal(err)
		}
	}
	rows, partial, err := h.AdviceEffects(req.Session.SessionID, req.AgentID, req.Session.ProjectID, req.Session.Checkout, receipt.EntryID)
	if err != nil || partial || len(rows) != 2 {
		t.Fatal(rows, partial, err)
	}
	if rows[0].Observed == nil || rows[0].Observed.Verdict != "held" || rows[1].Observed == nil || rows[1].Observed.Verdict != "broken" || rows[0].Key == rows[1].Key {
		t.Fatal(rows)
	}
	if got := rows[0].Assessment("outdated-since", rows[0].Observed.InputsHash, req.Branch); !strings.Contains(got, "checks held at this action") {
		t.Fatal(got)
	}
	if got := rows[1].Assessment("outdated-since", rows[0].Observed.InputsHash, req.Branch); !strings.Contains(got, "review this action") {
		t.Fatal(got)
	}
	if got := rows[0].Assessment("wrong-all-along", "", req.Branch); !strings.Contains(got, "suspect") {
		t.Fatal(got)
	}
}
