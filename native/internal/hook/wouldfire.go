package hook

import (
	"encoding/json"
	"io"

	"github.com/mex-memory/mex/native/delivery"
	"github.com/mex-memory/mex/native/delivery/entries"
)

const wouldFireEntries = 64 // entry files in one request

type wouldFireRequest struct {
	// Entries are entry files' bytes, as written: the run's learned rules.
	Entries []string                 `json:"entries"`
	Level   string                   `json:"level"`
	Edits   []delivery.WouldFireEdit `json:"edits"`
}

// wouldFire replays a person's past edits through the delivery matchers
// at $0, for the review list at the end of a learning run. It reads no files,
// opens no database and never denies anything.
func wouldFire(stdin io.Reader, stdout io.Writer) int {
	var req wouldFireRequest
	enc := json.NewEncoder(stdout)
	if err := json.NewDecoder(io.LimitReader(stdin, maxPayload)).Decode(&req); err != nil || len(req.Entries) > wouldFireEntries {
		_ = enc.Encode(checkFailure{Error: "invalid request"})
		return 2
	}
	level := req.Level
	if level != "team" {
		level = "personal"
	}
	items := make([]*entries.Item, 0, len(req.Entries))
	for _, raw := range req.Entries {
		if it, err := entries.ItemFromFile([]byte(raw), level); err == nil {
			items = append(items, it)
		}
	}
	matches := delivery.WouldFire(items, req.Edits)
	if matches == nil {
		matches = []delivery.WouldFireMatch{}
	}
	_ = enc.Encode(struct {
		OK      bool                      `json:"ok"`
		Matches []delivery.WouldFireMatch `json:"matches"`
	}{true, matches})
	return 0
}
