package hook

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record/place"
)

func TestProseStopTrialRecordsWithoutChangingStopAndPointsOnce(t *testing.T) {
	h, env := fakeHome(t, true)
	root, err := place.RealPath(repo(t, t.TempDir()))
	if err != nil {
		t.Fatal(err)
	}
	register(t, h, root, projectID, "on", "")
	id := "mx_deep" + strings.Repeat("a", 32)
	file := filepath.Join(root, "src", "file.ts")
	write(t, file, "export {}\n")
	write(t, filepath.Join(root, ".mex", "learned", id+".md"), `---
mex:
  id: `+id+`
  kind: rule
  scope: ["src/**"]
  source: {type: docs, ref: CONTRIBUTING.md, producer: learn-deeper}
  evidence: docs
  one_line: Use structured events.
  checks: [{kind: scope, role: complete, target: {glob: "src/**"}, saw: {count: 1}, files: {}}]
  status: active
  created: 2026-11-03
---
Use structured events so consumers can filter by type.
`)
	event := contract.Event{Agent: "claude-code", SessionID: "first"}
	noteChanged(event, h.mex, []fileEdit{{path: file}})
	call := func(session, name string) string {
		body, _ := json.Marshal(map[string]any{"session_id": session, "hook_event_name": name, "source": "startup", "cwd": root, "prompt": "Continue the work"})
		code, out := run(t, []string{"claude-code", name}, bytes.NewReader(body), env)
		if code != 0 {
			t.Fatalf("%s exited %d", name, code)
		}
		return out
	}
	name := place.ShortHash(root)
	request := filepath.Join(h.mex, stopCheckPending, name+".json")
	off := call("first", "Stop")
	if _, err := os.Stat(request); !os.IsNotExist(err) {
		t.Fatal("disabled trial wrote a request")
	}
	write(t, filepath.Join(h.mex, "hook-delivery", projectID+".json"), `{"version":1,"stop_check":true}`)
	if on := call("first", "Stop"); on != off || strings.Contains(on, "deny") {
		t.Fatalf("Stop changed from %q to %q", off, on)
	}
	var pending stopCheckRequest
	data, err := os.ReadFile(request)
	if err != nil || json.Unmarshal(data, &pending) != nil || len(pending.Rules) != 1 || pending.Rules[0].ID != id || pending.Rules[0].Paths[0] != "src/file.ts" {
		t.Fatalf("request = %s, %v", data, err)
	}
	pointer := stopCheckPointer{Project: projectID, Checkout: root, At: time.Now().UnixMilli(), Flags: []stopCheckFlag{{ID: id, Path: "src/file.ts", Line: 1}}}
	data, _ = json.Marshal(pointer)
	write(t, filepath.Join(h.mex, stopCheckPointers, name+".json"), string(data))
	if out := call("next", "SessionStart"); strings.Contains(out, id) {
		t.Fatalf("session start carried the pointer: %s", out)
	}
	if out := call("next", "UserPromptSubmit"); !strings.Contains(out, "mex recall "+id) {
		t.Fatalf("prompt did not carry the pointer: %s", out)
	}
	if out := call("next", "UserPromptSubmit"); strings.Contains(out, "mex recall "+id) {
		t.Fatalf("pointer repeated: %s", out)
	}
	shown, err := os.ReadFile(filepath.Join(h.mex, stopCheckPointers, name+".shown"))
	if err != nil || json.Unmarshal(shown, &pointer) != nil || pointer.Session != "next" {
		t.Fatalf("delivery receipt = %s, %v", shown, err)
	}
}
