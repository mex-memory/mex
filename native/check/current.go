package check

import (
	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/internal/judgement"
)

// CurrentInputsHash reuses the evaluator's identity for a loaded delivery item,
// without evaluating or publishing verdicts. Model evidence bounds still apply.
func CurrentInputsHash(checkout, directory, project string, item *entries.Item) (string, bool) {
	if item == nil || item.Entry == nil {
		return "", false
	}
	ev, err := NewEvaluator(checkout)
	if err != nil {
		return "", false
	}
	defer ev.Close()
	ev.files.maxBytes = judgement.MaxEvidenceFileBytes
	checks := make([]Check, 0, len(item.Entry.Checks))
	needsIndex := false
	for _, c := range item.Entry.Checks {
		checks = append(checks, Check{Kind: c.Kind, Role: c.Role, Target: c.Target, Saw: c.Saw, Files: c.Files})
		needsIndex = needsIndex || c.Kind == "pattern" || c.Kind == "symbol"
	}
	asOf := ""
	if needsIndex {
		ix, err := index.Open(directory, project, checkout)
		if err != nil {
			return "", false
		}
		defer ix.Close()
		ev.UseIndex(ix)
		asOf = ix.AsOf()
	}
	return ev.inputsHash(Loaded{Hash: item.Hash, Entry: &Entry{Checks: checks}}, asOf), true
}
