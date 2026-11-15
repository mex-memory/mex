package delivery

import (
	"strings"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/internal/gitstate"
	"github.com/mex-memory/mex/native/record"
)

// Explicit advisory hints let an already-used note correct itself without
// winning another ordinary candidate slot. The ledger checks exact receipt,
// actor and epoch under its writer lock and always debits the reserved lane.
type correctionBlock struct {
	text   string
	tokens int
}

func adviceBlock(h *record.Hooks, ev contract.Event, env Environment, ids []string) (correctionBlock, error) {
	var out correctionBlock
	at, ok := gitstate.Read(ev.Checkout)
	if !ok || len(ids) == 0 {
		return out, nil
	}
	reader, err := record.OpenRecord(record.Location{Directory: env.RecordDirectory, Record: env.RecordDirectory + "/record.db"})
	if err != nil {
		return out, nil
	}
	defer reader.Close()
	advisories := reader.Advice(ev.ProjectID, ev.Checkout, at.Branch, ids)
	epoch, found, err := h.CurrentEpoch(ev.SessionID, ev.AgentID)
	if err != nil || !found {
		return out, err
	}
	corrected, err := h.CorrectedAdvice(ev.SessionID, ev.AgentID, ev.ProjectID, ev.Checkout, epoch.Number)
	if err != nil {
		return out, err
	}
	req := baseRequest(ev, env, ev.ProjectID, ev.Checkout)
	texts := map[string]string{}
	spent := 0
	for _, a := range advisories {
		if corrected[a.Entry] {
			continue
		}
		for _, receipt := range a.Receipts {
			if receipt.Session != ev.SessionID || receipt.Agent != ev.AgentID || receipt.Epoch != epoch.Number {
				continue
			}
			effects, partial, err := h.AdviceEffects(ev.SessionID, ev.AgentID, ev.ProjectID, ev.Checkout, a.Entry)
			if err != nil {
				return out, err
			}
			for i := range effects {
				effects[i].Summary += " — " + effects[i].Assessment(a.Origin.Kind, a.Origin.HeldInputsHash, a.Branch)
			}
			text := boundedCorrection(a.Text+" ("+a.Label+")", effects, partial || a.Partial)
			cost := entries.EstimateTokens(text) + 8
			if cost > reservedLane-spent {
				continue
			}
			req.Candidates = append(req.Candidates, record.DeliveryCandidate{EntryID: a.Entry, Moment: "correction", Form: "one-line", Tokens: cost, Correction: true, CorrectionFor: receipt.ID})
			texts[a.Entry] = text
			spent += cost
			break
		}
	}
	if len(req.Candidates) == 0 {
		return out, nil
	}
	// A branch switch during the read cannot authorize a correction elsewhere.
	if current, ok := gitstate.Read(ev.Checkout); !ok || current != at {
		return out, nil
	}
	res, err := h.CheckAndMark(req)
	if err != nil {
		return out, err
	}
	var lines []string
	block := ""
	for _, receipt := range res.Receipts {
		if receipt.Correction {
			out.tokens += receipt.Tokens
			lines = append(lines, texts[receipt.EntryID])
			block = receipt.BlockID
		}
	}
	if len(lines) == 0 {
		return out, nil
	}
	out.text = "[mex " + block + "]\n" + strings.Join(lines, "\n")
	return out, nil
}
