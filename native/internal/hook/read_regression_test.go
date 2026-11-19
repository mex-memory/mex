package hook

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/internal/adapter/claude"
	localrecord "github.com/mex-memory/mex/native/record"
)

func TestOutlinedReadRiskUsesOriginalBatchText(t *testing.T) {
	c := setupRead(t)
	entry := `---
mex:
  id: mx_readrisk
  kind: rule
  scope: ["src/**"]
  source:
    type: person
    ref: typed note
    quote: "Use the safe command parser."
  evidence: person
  one_line: "Use the safe command parser."
  when:
    - type: anti
      match: literal
      pattern: commander
  checks: []
  status: active
  created: 2026-11-03
---
Use the safe command parser.
`
	if _, err := entries.Parse([]byte(entry)); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(c.root, ".mex", "learned", "mx_readrisk.md"), entry)
	past := time.Now().Add(-5 * time.Second)
	_ = os.Chtimes(filepath.Join(c.root, ".mex", "learned", "mx_readrisk.md"), past, past)
	r := c.call(t, "PostToolUse", c.payload(t, "PostToolUse", "Read", map[string]any{"file_path": c.file}, c.readResponse(t)))
	var outlined readResponse
	if json.Unmarshal(r.HookSpecificOutput.UpdatedToolOutput, &outlined) != nil || strings.Contains(outlined.File.Content, "commander") {
		t.Fatal("test did not hide literal in outline")
	}
	raw, err := os.ReadFile("../adapter/claude/testdata/payloads/PostToolBatch.json")
	if err != nil {
		t.Fatal(err)
	}
	var batch map[string]any
	if json.Unmarshal(raw, &batch) != nil {
		t.Fatal("fixture")
	}
	batch["cwd"], batch["session_id"] = c.root, "s1"
	calls := batch["tool_calls"].([]any)
	read := calls[0].(map[string]any)
	read["tool_input"] = map[string]any{"file_path": c.file}
	read["tool_response"] = "1\t" + outlined.File.Content
	batch["tool_calls"] = calls[:1]
	// File changes must not replace evidence of the original read.
	write(t, c.file, "now changed")
	body, _ := json.Marshal(batch)
	ev, err := (claude.Profile{}).Parse("PostToolBatch", body)
	if err != nil {
		t.Fatal(err)
	}
	restored := originalBatchReads(ev, c.h, c.h.mex)
	if !strings.Contains(restored.Batch[0].Output.Text, "commander") {
		t.Fatal("original not restored")
	}
	c.h.deliveryError = func(err error) { t.Errorf("delivery: %v", err) }
	_ = handle("claude-code", "PostToolBatch", body, true, c.h, time.Now())
	db, err := sql.Open("sqlite", filepath.Join(c.h.mex, "hooks.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var count int
	if err = db.QueryRow("SELECT count(*) FROM deliveries WHERE entry_id='mx_readrisk' AND moment='read-risk'").Scan(&count); err != nil || count == 0 {
		t.Fatalf("read-risk did not fire: %d %v", count, err)
	}

}
func TestUnchangedReadAfterOutline(t *testing.T) {
	for _, changed := range []bool{false, true} {
		t.Run(fmt.Sprint(changed), func(t *testing.T) {
			c := setupRead(t)
			response := c.readResponse(t)
			file := response["file"].(map[string]any)
			content := file["content"].(string)
			// This host returned fewer lines than the entire file.
			const returned = 1000
			file["content"], file["numLines"] = returnedReadText(content, returned), returned
			r := c.call(t, "PostToolUse", c.payload(t, "PostToolUse", "Read", map[string]any{"file_path": c.file}, response))
			if len(r.HookSpecificOutput.UpdatedToolOutput) == 0 {
				t.Fatal("not outlined")
			}
			if !strings.Contains(string(r.HookSpecificOutput.UpdatedToolOutput), "full text of this read: Read offset=1 limit=1000") {
				t.Fatal("misleading full-text instruction")
			}
			r = c.call(t, "PreToolUse", c.payload(t, "PreToolUse", "Read", map[string]any{"file_path": c.file}, nil))
			var in map[string]any
			_ = json.Unmarshal(r.HookSpecificOutput.UpdatedInput, &in)
			if in["limit"] != float64(returned) {
				t.Fatalf("unbounded read: %s", r.HookSpecificOutput.UpdatedInput)
			}
			if changed {
				write(t, c.file, "changed")
			}
			raw, err := os.ReadFile("../adapter/claude/testdata/payloads/PostToolUse-Read-unchanged.json")
			if err != nil {
				t.Fatal(err)
			}
			var payload map[string]any
			_ = json.Unmarshal(raw, &payload)
			payload["cwd"] = c.root
			payload["tool_input"] = map[string]any{"file_path": c.file}
			body, _ := json.Marshal(payload)
			r = c.call(t, "PostToolUse", body)
			var recovered readResponse
			if json.Unmarshal(r.HookSpecificOutput.UpdatedToolOutput, &recovered) != nil || recovered.Type != "text" {
				t.Fatalf("stub unchanged: %+v", r)
			}
			if changed {
				if !strings.Contains(recovered.File.Content, "offset=1 limit=1000") {
					t.Fatal(recovered.File.Content)
				}
			} else if recovered.File.TotalLines != c.lines || recovered.File.Content != returnedReadText(content, returned) {
				t.Fatal("wrong recovered text")
			}
		})
	}
}
func TestDeliveryIntentControlsLevers(t *testing.T) {
	for _, intent := range []string{"investigating", "reproducing", "working"} {
		t.Run(intent, func(t *testing.T) {
			h, env, root := codexSetup(t)
			hooks, err := localrecord.OpenHooks(hooksLocation(h, h.mex))
			if err != nil {
				t.Fatal(err)
			}
			_, err = hooks.CheckAndMark(localrecord.DeliveryRequest{Session: localrecord.Session{Agent: "codex", SessionID: "c1", ProjectID: projectID, Checkout: root}, Now: time.Now(), Reason: "startup", Intent: intent, Budget: 1000})
			hooks.Close()
			if err != nil {
				t.Fatal(err)
			}
			raw := codexPre(t, root, map[string]any{"command": "npm test"})
			_, out := run(t, []string{"codex", "PreToolUse"}, bytes.NewReader(raw), env)
			if strings.Contains(out, "updatedInput") != (intent != "reproducing") {
				t.Fatalf("%s: %s", intent, out)
			}
			// The last typed instruction is separate from delivery intent.
			_, whole := promptWords("Investigate and debug the flaky test")
			if whole {
				t.Fatal("intent heuristic remains")
			}
			for _, s := range []string{"full output", "raw output", "whole output", "untrimmed"} {
				_, whole = promptWords(s)
				if !whole {
					t.Fatal(s)
				}
			}
		})
	}
}

func TestDeliveryIntentControlsShellTrim(t *testing.T) {
	for _, intent := range []string{"investigating", "reproducing"} {
		t.Run(intent, func(t *testing.T) {
			h, env := fakeHome(t, true)
			env = withEnv(env, map[string]string{"MEX_LEVERS": "on"})
			h = homeFrom(env)
			root := repo(t, t.TempDir())
			register(t, h, root, projectID, "on", "")
			hooks, err := localrecord.OpenHooks(hooksLocation(h, h.mex))
			if err != nil {
				t.Fatal(err)
			}
			_, err = hooks.CheckAndMark(localrecord.DeliveryRequest{Session: localrecord.Session{Agent: "claude-code", SessionID: "s1", ProjectID: projectID, Checkout: root}, Now: time.Now(), Reason: "startup", Intent: intent, Budget: 1000})
			hooks.Close()
			if err != nil {
				t.Fatal(err)
			}
			_, out := run(t, []string{"claude-code", "PostToolUse"}, bytes.NewReader(claudeBash(t, "PostToolUse", "s1", root, "npm test", longTestRun())), env)
			r := parseClaude(t, out)
			if (r.HookSpecificOutput.UpdatedToolOutput != nil) != (intent != "reproducing") {
				t.Fatalf("%s: %s", intent, out)
			}
		})
	}
}
