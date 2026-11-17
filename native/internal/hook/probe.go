package hook

import (
	"encoding/json"
	"io"

	"github.com/mex-memory/mex/native/delivery"
)

type probeRequest struct {
	Checkout        string   `json:"checkout"`
	ProjectID       string   `json:"project_id"`
	MexHome         string   `json:"mex_home"`
	RecordDirectory string   `json:"record_directory"`
	Entries         []string `json:"entries"`
}

// deliveryProbe answers `mex-hook --delivery-probe`: what the controller would
// send for each entry now, by verdict, without writing the ledger. Used by the
// knowledge bench gate. Like --check-run it reports errors.
func deliveryProbe(stdin io.Reader, stdout io.Writer) int {
	var req probeRequest
	enc := json.NewEncoder(stdout)
	if err := json.NewDecoder(io.LimitReader(stdin, maxPayload)).Decode(&req); err != nil || req.Checkout == "" || req.ProjectID == "" || req.RecordDirectory == "" || len(req.Entries) > 10000 {
		_ = enc.Encode(checkFailure{Error: "invalid request"})
		return 2
	}
	results, err := delivery.Probe(delivery.Environment{Home: req.MexHome, RecordDirectory: req.RecordDirectory}, req.ProjectID, req.Checkout, req.Entries)
	if err != nil {
		_ = enc.Encode(checkFailure{Error: err.Error()})
		return 1
	}
	_ = enc.Encode(struct {
		OK      bool                   `json:"ok"`
		Results []delivery.ProbeResult `json:"results"`
	}{true, results})
	return 0
}
