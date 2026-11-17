package hook

import (
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/internal/contract"
	localrecord "github.com/mex-memory/mex/native/record"
)

func TestWhatConsumesOnlyExactTypedMainPrompt(t *testing.T) {
	for _, tc := range []struct {
		text  string
		typed bool
		sub   string
		want  bool
	}{{" MEX WHAT ", true, "", true}, {"mex what", false, "", false}, {"mex what", true, "child", false}, {"please mex what", true, "", false}} {
		ev := contract.Event{Kind: contract.Prompt, SessionID: "s", AgentID: tc.sub, Prompt: &contract.PromptIn{Text: tc.text, Typed: tc.typed}}
		if whatPrompt(ev) != tc.want {
			t.Fatal(tc)
		}
	}
}

func TestWhatPromptHasNoModelContext(t *testing.T) {
	h, _ := fakeHome(t, true)
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "on", "")
	payload, _ := json.Marshal(map[string]string{"session_id": "s", "cwd": root, "prompt": " MEX WHAT "})
	out := string(handle("claude-code", "UserPromptSubmit", payload, true, h, time.Now()))
	if !strings.Contains(out, `"decision":"block"`) || !strings.Contains(out, "MEX · this session:") || strings.Contains(out, "additionalContext") {
		t.Fatal(out)
	}
	summary, err := localrecord.ReadWhat(filepath.Join(h.mex, "hooks.db"), "s", projectID, root)
	if err != nil || summary.Gave != 0 {
		t.Fatal(summary, err)
	}
}
