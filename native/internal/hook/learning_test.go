package hook

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/internal/adapter"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record/place"
)

func TestLearningProfilesMatchFixtureBackedAdapterEvents(t *testing.T) {
	for _, agent := range adapter.Agents() {
		profile, _ := adapter.Lookup(agent)
		caps := profile.Capabilities()
		learning := caps.Learning()
		_, prompt := caps.Support(contract.Prompt)
		_, ended := caps.Support(contract.SessionEnd)
		_, stop := caps.Support(contract.Stop)
		if !learning.CapturesTyped() || !prompt || (learning.Finish == "session-end" && !ended) || (learning.Finish == "idle" && !stop) {
			t.Errorf("%s has incompatible learning triggers: %+v", agent, learning)
		}
		full := agent == "claude-code" || agent == "codex"
		if learning.Choices != full || learning.Memory != full || (learning.Cache && learning.Outside == "none") {
			t.Errorf("%s has unconfirmed learning inputs: %+v", agent, learning)
		}
	}
}

func TestLearningCachesOnlyTheLatestSafeFinalReplyAndWakesAcrossAgents(t *testing.T) {
	h, env := fakeHome(t, true)
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "on", "")
	checkout, err := place.RealPath(root)
	if err != nil {
		t.Fatal(err)
	}
	controls := filepath.Join(h.mex, "controls.json")
	cache := filepath.Join(h.mex, "filter-replies", place.ShortHash(strings.Join([]string{projectID, checkout, "gemini", "g"}, "\x00")))
	trigger := func(agent, event, session string, values map[string]any) {
		t.Helper()
		payload := map[string]any{"session_id": session, "cwd": root, "hook_event_name": event}
		for k, v := range values {
			payload[k] = v
		}
		body, err := json.Marshal(payload)
		if err != nil {
			t.Fatal(err)
		}
		if code, _ := run(t, []string{agent, event}, bytes.NewReader(body), env); code != 0 {
			t.Fatal(code)
		}
	}
	gemini := func(event string, values map[string]any) { trigger("gemini", event, "g", values) }
	read := func() string {
		t.Helper()
		files, err := os.ReadDir(cache)
		if err != nil || len(files) != 1 {
			t.Fatalf("expected one cached reply: %v %v", files, err)
		}
		body, err := os.ReadFile(filepath.Join(cache, files[0].Name()))
		if err != nil {
			t.Fatal(err)
		}
		return string(body)
	}
	gemini("BeforeAgent", map[string]any{"prompt": "Earlier typed words"})
	gemini("AfterAgent", map[string]any{"prompt_response": "Should stay uncached"})
	if _, err := os.Stat(cache); !os.IsNotExist(err) {
		t.Fatal("opt-out saved a reply")
	}
	write(t, controls, `{"version":1,"off":false,"capture":true,"session_learning":true}`)
	gemini("BeforeAgent", map[string]any{"prompt": "What about the cart?"})
	gemini("AfterAgent", map[string]any{"prompt_response": "First visible choice"})
	if text := read(); !strings.Contains(text, "First visible choice") || strings.Contains(text, "What about the cart?") {
		t.Fatal(text)
	}
	gemini("AfterAgent", map[string]any{"prompt_response": strings.Repeat("<", 6000)})
	if text := read(); !strings.Contains(text, `"text":""`) {
		t.Fatal("an oversized reply left the previous response in the cache")
	}
	gemini("AfterAgent", map[string]any{"prompt_response": "Choice before a pasted turn"})
	gemini("BeforeAgent", map[string]any{"prompt": strings.Repeat("Pasted text.\n", 30)})
	if text := read(); !strings.Contains(text, `"text":""`) {
		t.Fatal("the pasted turn left a previous reply available to later prompts")
	}
	gemini("AfterAgent", map[string]any{"prompt_response": "New visible choice"})
	if text := read(); !strings.Contains(text, "New visible choice") || strings.Contains(text, "First visible choice") {
		t.Fatal(text)
	}
	gemini("BeforeAgent", map[string]any{"prompt": "Try the next plan"})
	gemini("AfterAgent", map[string]any{"prompt_response": "Closing acknowledgement"})
	if text := read(); !strings.Contains(text, "New visible choice") || !strings.Contains(text, `"for_prompt_at"`) || strings.Contains(text, "Closing acknowledgement") {
		t.Fatal(text)
	}
	files, _ := os.ReadDir(cache)
	if err := os.Remove(filepath.Join(cache, files[0].Name())); err != nil {
		t.Fatal(err)
	}
	gemini("BeforeAgent", map[string]any{"prompt": "Read the description"})
	gemini("BeforeTool", map[string]any{"tool_name": "read_file", "tool_input": map[string]any{"file_path": filepath.Join(t.TempDir(), "outside.txt")}})
	gemini("AfterAgent", map[string]any{"prompt_response": "Outside context must stay out"})
	if text := read(); !strings.Contains(text, `"text":""`) {
		t.Fatal(text)
	}
	gemini("BeforeAgent", map[string]any{"prompt": "Use this response"})
	gemini("AfterAgent", map[string]any{"prompt_response": "password=fixture-secret-123"})
	if text := read(); !strings.Contains(text, `"text":""`) {
		t.Fatal(text)
	}
	rows := journalOf(t, h, "g")
	for _, row := range rows {
		if row.Kind == "typed" && strings.Contains(row.Text, "visible choice") {
			t.Fatal("assistant response entered the typed journal")
		}
	}

	prior := startBackground
	q := 0
	startBackground = func(_ home, _ string) { q++ }
	t.Cleanup(func() { startBackground = prior })
	gemini("SessionEnd", nil)
	if q != 1 {
		t.Fatalf("finish hook started %d schedulers", q)
	}
	stored, err := filepath.Glob(filepath.Join(h.mex, "filter-pending", place.ShortHash(checkout)+".*.json"))
	if err != nil || len(stored) != 1 {
		t.Fatalf("session finish hint missing: %v %v", stored, err)
	}
	raw, err := os.ReadFile(stored[0])
	if err != nil {
		t.Fatal(err)
	}
	var request struct {
		Generation string `json:"generation"`
	}
	if err := json.Unmarshal(raw, &request); err != nil {
		t.Fatal(err)
	}
	finished, err := time.Parse(time.RFC3339Nano, request.Generation)
	if err != nil || !strings.HasSuffix(stored[0], "."+strconv.FormatInt(finished.UnixNano(), 10)+".json") {
		t.Fatalf("finish hint filename and generation differ: %s %s", filepath.Base(stored[0]), request.Generation)
	}
	wake := filepath.Join(h.mex, "filter-wake")
	old := time.Now().Add(-time.Minute)
	if err := os.Chtimes(wake, old, old); err != nil {
		t.Fatal(err)
	}
	trigger("codex", "PostToolUse", "other-host", map[string]any{"tool_name": "read_file", "tool_input": map[string]any{}})
	if q != 2 {
		t.Fatalf("unrelated host hook did not wake finished work: %d", q)
	}
}
