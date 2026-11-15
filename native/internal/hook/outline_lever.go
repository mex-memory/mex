package hook

import (
	"time"

	"github.com/mex-memory/mex/native/internal/contract"
)

// outlineRead shows a big file read as an outline (L2).
func outlineRead(ev contract.Event, h home, recordDirectory string, state *leverState, now time.Time) (contract.Reply, bool) {
	return contract.Reply{}, false
}

// outlineGuard applies the outline rules before a tool runs.
func outlineGuard(ev contract.Event, h home, recordDirectory string, state *leverState) (contract.Reply, bool) {
	return contract.Reply{}, false
}
