package record

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// RecordRuleOverride is the speed-bump writer's observation seam. A deliberate
// repeat must name an actual main-agent speed-bump receipt. Person is an
// optional stable person identity hash, never an agent name or inferred user.
// Delivery-03 owns calling this when its once-only blocker is repeated.
func (h *Hooks) RecordRuleOverride(receipt, entryHash, person string, now time.Time) error {
	validHash := func(s string) bool {
		if len(s) != 64 {
			return false
		}
		for _, c := range s {
			if !strings.ContainsRune("0123456789abcdef", c) {
				return false
			}
		}
		return true
	}
	if receipt == "" || len(receipt) > 128 || !strings.HasPrefix(entryHash, "sha256:") || !validHash(strings.TrimPrefix(entryHash, "sha256:")) || (person != "" && !validHash(person)) {
		return errors.New("invalid rule override")
	}
	detail, _ := json.Marshal(struct {
		Version   int    `json:"version"`
		Type      string `json:"type"`
		EntryHash string `json:"entry_hash"`
		Person    string `json:"person,omitempty"`
	}{1, "speed-bump-override", entryHash, person})
	ctx, cancel := context.WithTimeout(context.Background(), h.budget.writer)
	defer cancel()
	return h.write(ctx, `INSERT INTO followups(delivery_id,ts,kind,detail)
 SELECT id,?,'wrong',? FROM deliveries d WHERE id=? AND agent_id='' AND moment='speed-bump' AND action='given'
 AND NOT EXISTS(SELECT 1 FROM followups f WHERE f.delivery_id=d.id AND f.kind='wrong')`, now.UTC().Format(time.RFC3339), string(detail), receipt)
}
