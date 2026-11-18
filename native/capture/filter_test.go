package capture

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record/place"
)

func TestFilterLifecycleMetadataAndTriggers(t *testing.T) {
	dir := t.TempDir()
	ev := contract.Event{Agent: "codex", Kind: contract.SessionStart, SessionID: "s", ProjectID: "p", Checkout: "/repo", Transcript: "/host/session.jsonl"}
	env := Env{RecordDirectory: dir, Now: time.Now()}
	if err := filterMetadata(ev, env); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "filter-sessions", place.ShortHash("p\x00s")+".json")
	var state FilterSession
	read := func() {
		t.Helper()
		data, err := os.ReadFile(file)
		if err != nil || json.Unmarshal(data, &state) != nil {
			t.Fatalf("bad metadata: %v", err)
		}
		if strings.Contains(string(data), "assistant words") {
			t.Fatal("reply content retained")
		}
	}
	read()
	if state.Finished || state.Transcript != ev.Transcript {
		t.Fatal(state)
	}
	request := filepath.Join(dir, "filter-pending", place.ShortHash(ev.Checkout)+".json")
	if _, err := os.Stat(request); err != nil {
		t.Fatal(err)
	}
	_ = os.Remove(request)
	ev.Kind = contract.PreTool
	_ = filterMetadata(ev, env)
	if _, err := os.Stat(request); !os.IsNotExist(err) {
		t.Fatal("ordinary tool hook requested a filter")
	}
	ev.Kind = contract.Stop
	_ = filterMetadata(ev, env)
	read()
	if state.Finished {
		t.Fatal("ordinary Stop marked a session finished")
	}
	if _, err := os.Stat(request); !os.IsNotExist(err) {
		t.Fatal("Stop requested a filter")
	}
	ev.Kind = contract.SessionEnd
	_ = filterMetadata(ev, env)
	read()
	if !state.Finished {
		t.Fatal("SessionEnd was not recorded")
	}
	ev.Kind = contract.PreCompact
	ev.Transcript = "" // Some host events omit this field.
	_ = filterMetadata(ev, env)
	read()
	if state.Finished {
		t.Fatal("activity failed to clear finished")
	}
	if state.Transcript != "/host/session.jsonl" {
		t.Fatal("lost a prior transcript reference")
	}
	if _, err := os.Stat(request); err != nil {
		t.Fatal("pre-compaction request missing")
	}
}

func TestFilterIgnoresSubagentsAndRefusesRedirects(t *testing.T) {
	dir := t.TempDir()
	ev := contract.Event{Agent: "codex", Kind: contract.SessionStart, AgentID: "sub", SessionID: "s", ProjectID: "p", Checkout: "/repo"}
	if err := filterMetadata(ev, Env{RecordDirectory: dir}); err != nil {
		t.Fatal(err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 0 {
		t.Fatal("subagent wrote filter metadata")
	}
	out := t.TempDir()
	if err := os.Symlink(out, filepath.Join(dir, "filter-sessions")); err != nil {
		t.Skip("symlinks unavailable")
	}
	ev.AgentID = ""
	if err := filterMetadata(ev, Env{RecordDirectory: dir}); err == nil {
		t.Fatal("redirected metadata accepted")
	}
	if entries, _ := os.ReadDir(out); len(entries) != 0 {
		t.Fatal("wrote outside the record")
	}
}
