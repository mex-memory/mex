package delivery

import (
	"time"

	"github.com/mex-memory/mex/native/capture"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record"
)

// carryBlocks are what the person's earlier work leaves for a new session on
// the branch: a teammate's handoff, then 'where we left off'. Each is shown
// once per machine (notices_shown) and never on a resume, and each carries
// its own delivery receipt like any other block.
func carryBlocks(h *record.Hooks, ev contract.Event, env Environment) []string {
	if ev.AgentID != "" {
		return nil
	}
	var carries []capture.Carry
	if c, ok := capture.HandoffCarry(ev); ok {
		carries = append(carries, c)
	}
	if c, ok := capture.ContinuityCarry(ev, capture.Env{RecordDirectory: env.RecordDirectory, Now: env.Now}); ok {
		carries = append(carries, c)
	}
	var out []string
	session := record.Session{SessionID: ev.SessionID, Agent: ev.Agent, ProjectID: ev.ProjectID, Checkout: ev.Checkout}
	for _, c := range carries {
		first, err := h.ShowOnce(session, c.NoticeID, env.Now.UTC().Format(time.RFC3339Nano))
		if err != nil || !first {
			continue
		}
		req := baseRequest(ev, env, ev.ProjectID, ev.Checkout)
		req.Candidates = []record.DeliveryCandidate{{EntryID: c.EntryID, Moment: "carry", Form: "full", Action: "given", Tokens: c.Tokens, ContentHash: contentHash(c.Text)}}
		res, err := h.CheckAndMark(req)
		if err != nil {
			continue
		}
		for _, r := range res.Receipts {
			if r.EntryID == c.EntryID && r.Action == "given" && r.BlockID != "" {
				out = append(out, "[mex "+r.BlockID+"]\n"+c.Text)
				break
			}
		}
	}
	return out
}
