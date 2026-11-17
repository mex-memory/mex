package hook

import (
	"encoding/json"
	"github.com/mex-memory/mex/native/delivery"
	"github.com/mex-memory/mex/native/delivery/entries"
	"io"
)

func pairStudy(in io.Reader, out io.Writer) int {
	var req struct {
		Entries []*entries.Entry `json:"entries"`
	}
	if json.NewDecoder(io.LimitReader(in, maxPayload)).Decode(&req) != nil || len(req.Entries) > 100 {
		_, _ = io.WriteString(out, "{}\n")
		return 0
	}
	_ = json.NewEncoder(out).Encode(delivery.StudyPairs(req.Entries))
	return 0
}
