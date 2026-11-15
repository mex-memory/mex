package delivery

import (
	"path/filepath"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/brief"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
)

// Outside the canonical mx_ namespace, so a real entry cannot collide with it.
const startMarker = "mex:start-brief"

// startBlock fills the lifecycle's start slot using the same CheckAndMark
// transaction as moment delivery. Its marker and entry receipts debit one
// ledger, so resumes and parallel starts cannot send a different brief.
func startBlock(h *record.Hooks, ev contract.Event, env Environment) (string, error) {
	if ev.AgentID != "" {
		return "", nil
	}
	cwd, err := place.RealPath(ev.Cwd)
	if err != nil {
		return "", nil // unavailable source cannot authorize a brief
	}
	area := ""
	if filepath.Clean(cwd) != filepath.Clean(ev.Checkout) {
		var ok bool
		area, ok = place.RelativeToCheckout(ev.Checkout, cwd)
		if !ok {
			return "", nil
		}
	}
	result, err := brief.Build(brief.Options{Checkout: ev.Checkout, MexHome: env.Home, ProjectID: ev.ProjectID, Agent: ev.Agent, Path: area, RecordDirectory: env.RecordDirectory, SessionID: ev.SessionID, AgentID: ev.AgentID, NativeCwd: ev.Cwd, Deadline: time.Now().Add(100 * time.Millisecond)})
	if err != nil {
		return "", nil
	}
	req := baseRequest(ev, env, ev.ProjectID, ev.Checkout)
	req.OnceEntry = startMarker
	req.Candidates = []record.DeliveryCandidate{{EntryID: startMarker, Moment: "start-brief", Form: "one-line", Action: "given", Tokens: brief.TokenBound(brief.Priority) + 32, ContentHash: contentHash(brief.Priority)}}
	for _, item := range result.Items {
		req.Candidates = append(req.Candidates, record.DeliveryCandidate{EntryID: item.ID, Moment: "start-brief", Form: "one-line", Action: "given", Tokens: item.Tokens, ContentHash: contentHash(item.Hash + "\n" + item.Line)})
	}
	res, err := h.CheckAndMark(req)
	if err != nil {
		return "", err
	}
	var ids []string
	block := ""
	for _, r := range res.Receipts {
		if r.Action != "given" {
			continue
		}
		if r.EntryID == startMarker {
			block = r.BlockID
		} else {
			ids = append(ids, r.EntryID)
		}
	}
	if block == "" {
		return "", nil
	}
	text := result.Render(ids)
	_, body, _ := strings.Cut(text, "\n")
	return "[mex " + block + "]\n" + body, nil
}
