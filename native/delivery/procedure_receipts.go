package delivery

import (
	pathscope "github.com/mex-memory/mex/native/internal/scope"
	"github.com/mex-memory/mex/native/record"
)

// The edit that caused delivery is already known. A later successful edit
// in a different role is the observation that counts for this procedure.
func procedureReceiptTarget(p planned) record.SurfaceTarget {
	target := record.SurfaceTarget{Origin: "learned-procedure:" + p.item.Entry.ID}
	for _, trigger := range p.item.Entry.When {
		if trigger.Type == "creates" && !pathscope.MatchesScope(trigger.Pattern, p.rel) {
			target.Scopes = append(target.Scopes, trigger.Pattern)
		}
	}
	return target
}
