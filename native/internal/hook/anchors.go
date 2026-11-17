package hook

import (
	"encoding/json"
	"io"

	"github.com/mex-memory/mex/native/delivery"
	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/internal/contract"
)

// Explicit read-only study entrypoint; never opens hooks.db or changes a gate.
func anchorStudy(in io.Reader, out io.Writer) int {
	var req struct {
		Directory string   `json:"record_directory"`
		Project   string   `json:"project"`
		Checkout  string   `json:"checkout"`
		Prompts   []string `json:"prompts"`
		// Entries are optional: with them, each row also reports the team-phrase
		// pointers those entries would earn.
		Entries []*entries.Entry `json:"entries"`
	}
	if json.NewDecoder(io.LimitReader(in, maxPayload)).Decode(&req) != nil || len(req.Prompts) > 512 {
		return 2
	}
	type row struct {
		Extracted []delivery.Anchor        `json:"extracted"`
		Verified  []delivery.Anchor        `json:"verified"`
		Phrases   []delivery.VocabularyHit `json:"phrases"`
	}
	rows := make([]row, 0, len(req.Prompts))
	for _, text := range req.Prompts {
		ev := contract.Event{Checkout: req.Checkout, ProjectID: req.Project, Prompt: &contract.PromptIn{Text: text, Typed: true}}
		env := delivery.Environment{RecordDirectory: req.Directory}
		rows = append(rows, row{delivery.ExtractAnchors(text), delivery.VerifyAnchors(ev, env), delivery.VocabularyStudy(ev, env, req.Entries)})
	}
	if json.NewEncoder(out).Encode(rows) != nil {
		return 1
	}
	return 0
}
