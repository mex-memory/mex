package hook

import "github.com/mex-memory/mex/native/internal/contract"

// wrapCodexCommand rewrites a simple Codex command to run through the wrapper (L4).
func wrapCodexCommand(ev contract.Event, h home, state *leverState) contract.Reply {
	return contract.Reply{}
}
