package record

import (
	"context"
	"testing"
)

func TestContentionUniqueOffersAndBudgetCause(t *testing.T) {
	for _, shadow := range []bool{false, true} {
		h, err := openHooks(testLocation(t), testBudget)
		if err != nil {
			t.Fatal(err)
		}
		req := deliveryRequest()
		req.Budget = 150
		if shadow {
			req.Candidates[0].Mode = "shadow"
		}
		first, err := h.CheckAndMark(req)
		if err != nil {
			t.Fatal(err)
		}
		if first.Epoch.CandidateTokens != 100 || first.Epoch.AdmittedTokens != 100 {
			t.Fatal(first.Epoch)
		}
		req.Candidates[0].EntryID = "mx_second"
		for range 3 {
			if _, err = h.CheckAndMark(req); err != nil {
				t.Fatal(err)
			}
		}
		req.Candidates[0].EntryID = "mx_score"
		req.Admit = func(Epoch, DeliveryCandidate) bool { return false }
		result, err := h.CheckAndMark(req)
		if err != nil {
			t.Fatal(err)
		}
		if result.Epoch.CandidateTokens != 300 || result.Epoch.AdmittedTokens != 100 || result.Epoch.BudgetHeld != 1 {
			t.Fatal(result.Epoch)
		}
		r, err := surfaceSummary(context.Background(), h.db, req.Session.ProjectID, req.Session.Checkout)
		if err != nil {
			t.Fatal(err)
		}
		if r.Contention.Epochs != 1 || r.Contention.Contested != 1 || r.Contention.Share == nil || *r.Contention.Share != 1 {
			t.Fatal(r.Contention)
		}
		req.Reason = "clear"
		req.Candidates = nil
		result, err = h.CheckAndMark(req)
		if err != nil {
			t.Fatal(err)
		}
		if result.Epoch.CandidateTokens != 0 || result.Epoch.BudgetHeld != 0 {
			t.Fatal(result.Epoch)
		}
		h.Close()
	}
}

func TestContentionFamiliesAndLegacyUnknown(t *testing.T) {
	h, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	req := deliveryRequest()
	req.Budget = 150
	child := req.Candidates[0]
	child.EntryID = "mx_child"
	child.Parent = req.Candidates[0].EntryID
	req.Candidates = append(req.Candidates, child)
	r, err := h.CheckAndMark(req)
	if err != nil {
		t.Fatal(err)
	}
	if r.Epoch.CandidateTokens != 200 || r.Epoch.AdmittedTokens != 0 || r.Epoch.BudgetHeld != 1 {
		t.Fatal(r.Epoch)
	}
	if _, err = h.db.Exec(`UPDATE epochs SET contention_measured=0`); err != nil {
		t.Fatal(err)
	}
	s, err := surfaceSummary(context.Background(), h.db, req.Session.ProjectID, req.Session.Checkout)
	if err != nil {
		t.Fatal(err)
	}
	if s.Contention.Epochs != 0 || s.Contention.UnknownEpochs != 1 || s.Contention.Share != nil {
		t.Fatal(s.Contention)
	}
}
