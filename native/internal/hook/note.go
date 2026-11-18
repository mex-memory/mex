package hook

import (
	"bytes"
	"context"
	"encoding/json"
	"os/exec"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/capture"
	"github.com/mex-memory/mex/native/internal/contract"
)

// noteTimeout bounds the in-session note. Prompt hooks have 10 s on both
// agents; the note write itself is one small file.
const noteTimeout = 5 * time.Second

// noteResult is what `node <cli> __hook-note` prints.
type noteResult struct {
	OK      bool   `json:"ok"`
	ID      string `json:"id"`
	Message string `json:"message"`
}

// runNote saves the note through the CLI's own note writer, so gates, the
// record and the entry format stay in one place. Tests replace it.
var runNote = func(h home, checkout, text string) noteResult {
	l, ok := h.launcher()
	if !ok || !exists(l.Entry) {
		return noteResult{Message: "MEX couldn't save the note here: run any `mex` command once, then try again, or use `mex note \"...\"`."}
	}
	ctx, cancel := context.WithTimeout(context.Background(), noteTimeout)
	defer cancel()
	body, _ := json.Marshal(map[string]string{"project": checkout, "text": text})
	cmd := exec.CommandContext(ctx, l.Node, l.Entry, "__hook-note")
	cmd.Dir = checkout
	cmd.Stdin = bytes.NewReader(body)
	// The CLI must not start hooks, setup or background work for this.
	cmd.Env = append(cmd.Environ(), "MEX_BACKGROUND=1", "MEX_INSTALL_AUTO=0", "MEX_TELEMETRY=0")
	out, err := cmd.Output()
	var res noteResult
	if json.Unmarshal(bytes.TrimSpace(out), &res) != nil {
		if err != nil {
			return noteResult{Message: "MEX couldn't save the note: the CLI didn't answer. Use `mex note \"...\"` instead."}
		}
		return noteResult{Message: "MEX couldn't save the note."}
	}
	return res
}

// typedNote handles `mex note: ...` typed in a session: a personal note,
// saved at once with no AI (sheet 21). The prompt is consumed, so the agent
// doesn't spend a turn on it.
func typedNote(ev contract.Event, h home) (contract.Reply, bool) {
	text, ok := capture.NoteCommand(ev, h.env)
	if !ok {
		return contract.Reply{}, false
	}
	if capture.HasSecret(text) {
		return contract.Reply{ConsumePrompt: true, PersonLine: "MEX didn't save that note: it looks like it holds a secret."}, true
	}
	res := runNote(h, ev.Checkout, text)
	line := strings.TrimSpace(res.Message)
	if res.OK {
		line = "Saved personal note " + res.ID + ". It stays on this machine; `mex share` offers it to the team."
	} else if line == "" {
		line = "MEX couldn't save the note."
	}
	return contract.Reply{ConsumePrompt: true, PersonLine: line}, true
}

func (h home) env(key string) string {
	if h.getenv == nil {
		return ""
	}
	return h.getenv(key)
}
