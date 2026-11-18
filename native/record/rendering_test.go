package record

import "testing"

func TestCompanionFamilyAdmittedTogether(t *testing.T) {
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	req := deliveryRequest()
	req.Budget = 150
	req.Candidates = append(req.Candidates, DeliveryCandidate{EntryID: "child", Parent: "mx_abcdef", Moment: "companion", Form: "one-line", Tokens: 100})
	r, err := h.CheckAndMark(req)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Receipts) != 2 || r.Receipts[0].Action != "held-back" || r.Receipts[1].Action != "withheld" || r.Epoch.TokensSent != 0 {
		t.Fatal(r)
	}
	req.Candidates[0].Exempt = true
	req.Candidates[1].Exempt = true
	r, err = h.CheckAndMark(req)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Receipts) != 2 || r.Epoch.TokensSent != 200 {
		t.Fatal(r)
	}
}
func TestLockedSimilarityObservesPriorReceiptHash(t *testing.T) {
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	req := deliveryRequest()
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	req.Candidates[0].EntryID = "other"
	req.Similar = func(c DeliveryCandidate, prior []GivenRow) string {
		if len(prior) == 1 && prior[0].EntryID == "mx_abcdef" && prior[0].ContentHash == "hash" {
			return "similar"
		}
		t.Fatal(prior)
		return ""
	}
	r, err := h.CheckAndMark(req)
	if err != nil {
		t.Fatal(err)
	}
	if len(r.Receipts) != 1 || r.Receipts[0].Action != "withheld" || r.Receipts[0].Detail != "similar" || r.Epoch.TokensSent != 100 {
		t.Fatal(r)
	}
}
