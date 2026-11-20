package hook

import (
	"encoding/json"
	"strings"

	"github.com/mex-memory/mex/native/internal/contract"
	localrecord "github.com/mex-memory/mex/native/record"
)

// PostToolBatch contains model-visible text, which may be an outline. Use the
// original bounded scan text captured by PostToolUse, even if the file changed.
func originalBatchReads(ev contract.Event, h home, directory string) contract.Event {
	if ev.Kind != contract.PostToolBatch || ev.Agent != "claude-code" || !h.outputLevers() {
		return ev
	}
	needed := false
	for _, t := range ev.Batch {
		if t.Name == contract.ToolRead && t.Output != nil && strings.Contains(t.Output.Text, "-line file shown as outline") {
			needed = true
		}
	}
	if !needed {
		return ev
	}
	hooks, err := localrecord.OpenHooks(hooksLocation(h, directory))
	if err != nil {
		return ev
	}
	defer hooks.Close()
	data, err := hooks.LeverState(ev.Agent, ev.SessionID, ev.AgentID)
	if err != nil {
		return ev
	}
	var state leverState
	if json.Unmarshal(data, &state) != nil {
		return ev
	}
	ev.Batch = append([]contract.Tool(nil), ev.Batch...)
	for i := range ev.Batch {
		t := &ev.Batch[i]
		m := state.Outlined[pathKey(t.Input.Path)]
		if t.Name == contract.ToolRead && t.Output != nil && strings.Contains(t.Output.Text, "-line file shown as outline") && m != nil && m.Context == state.Context {
			original, err := hooks.OutlineOriginal(ev.Agent, ev.SessionID, ev.AgentID, pathKey(t.Input.Path), state.Context)
			if err != nil || original == "" {
				continue
			}
			out := *t.Output
			out.Text = original
			t.Output = &out
		}
	}
	return ev
}
