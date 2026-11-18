package hook

import (
	"encoding/json"
	"io"

	"github.com/mex-memory/mex/native/brief"
	"github.com/mex-memory/mex/native/internal/contract"
)

func observeInstruction(ev contract.Event, h home, recordDirectory, path string) {
	brief.ObserveLoaded(brief.Options{Checkout: ev.Checkout, MexHome: h.mex, ProjectID: ev.ProjectID, Agent: ev.Agent, RecordDirectory: recordDirectory, SessionID: ev.SessionID, AgentID: ev.AgentID}, path)
}

// Read-only helper for `mex brief` and deterministic acceptance probes.
func briefRun(stdin io.Reader, stdout io.Writer) int {
	var opts brief.Options
	enc := json.NewEncoder(stdout)
	if json.NewDecoder(io.LimitReader(stdin, maxPayload)).Decode(&opts) != nil {
		_ = enc.Encode(checkFailure{Error: "invalid brief request"})
		return 2
	}
	result, err := brief.Build(opts)
	if err != nil {
		_ = enc.Encode(checkFailure{Error: err.Error()})
		return 1
	}
	_ = enc.Encode(struct {
		OK bool `json:"ok"`
		brief.Result
	}{true, result})
	return 0
}
