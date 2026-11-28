package hook

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCheckRunRecordBatch(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "package.json"), []byte(`{"scripts":{"test":"vitest run"}}`), 0o644); err != nil {
		t.Fatal(err)
	}
	req := map[string]any{"action": "record-batch", "checkout": root, "items": []map[string]any{
		{"kind": "key", "role": "complete", "target": map[string]any{"file": "package.json", "pointer": "/scripts/test"}},
		{"kind": "command", "role": "supporting", "target": map[string]any{"run": "npm run test", "file": "package.json", "pointer": "/scripts/test"}},
		{"kind": "key", "role": "complete", "target": map[string]any{"file": "package.json", "pointer": "/scripts/lint"}},
	}}
	body, _ := json.Marshal(req)
	var out bytes.Buffer
	if code := checkRun(bytes.NewReader(body), &out); code != 0 {
		t.Fatalf("exit %d: %s", code, out.String())
	}
	var reply struct {
		OK      bool `json:"ok"`
		Results []struct {
			OK    bool            `json:"ok"`
			Check json.RawMessage `json:"check"`
			Error string          `json:"error"`
		} `json:"results"`
	}
	if err := json.Unmarshal(out.Bytes(), &reply); err != nil || !reply.OK || len(reply.Results) != 3 {
		t.Fatalf("reply %s", out.String())
	}
	if !reply.Results[0].OK || !strings.Contains(string(reply.Results[0].Check), `"value":"vitest run"`) {
		t.Fatalf("key result %+v", reply.Results[0])
	}
	if !reply.Results[1].OK || !strings.Contains(string(reply.Results[1].Check), `"exists":true`) {
		t.Fatalf("command result %+v", reply.Results[1])
	}
	if reply.Results[2].OK || !strings.Contains(reply.Results[2].Error, "has no /scripts/lint") {
		t.Fatalf("missing key result %+v", reply.Results[2])
	}
}

func TestCheckRunRecordBatchBound(t *testing.T) {
	items := make([]map[string]any, maxRecordItems+1)
	for i := range items {
		items[i] = map[string]any{"kind": "key", "role": "complete", "target": map[string]any{}}
	}
	body, _ := json.Marshal(map[string]any{"action": "record-batch", "checkout": t.TempDir(), "items": items})
	var out bytes.Buffer
	if code := checkRun(bytes.NewReader(body), &out); code != 2 || !strings.Contains(out.String(), "too many items") {
		t.Fatalf("exit %d: %s", code, out.String())
	}
}

// A stored evaluation creates hooks.db on first use and fails loudly when the
// store can't be opened, never answering with an unstored report.
func TestCheckRunStoredEvaluate(t *testing.T) {
	root, records := t.TempDir(), t.TempDir()
	evaluate := func() (int, string) {
		body, _ := json.Marshal(map[string]any{"action": "evaluate", "checkout": root, "project_id": "p", "mex_home": t.TempDir(), "record_directory": records, "store": true})
		var out bytes.Buffer
		code := checkRun(bytes.NewReader(body), &out)
		return code, out.String()
	}
	if code, out := evaluate(); code != 0 || !strings.Contains(out, `"stored":true`) {
		t.Fatalf("first stored evaluate: exit %d: %s", code, out)
	}
	if _, err := os.Stat(filepath.Join(records, "hooks.db")); err != nil {
		t.Fatal(err)
	}
	records = t.TempDir()
	if err := os.Mkdir(filepath.Join(records, "hooks.db"), 0o700); err != nil {
		t.Fatal(err)
	}
	if code, out := evaluate(); code != 1 || !strings.Contains(out, "verdict store") {
		t.Fatalf("unopenable store: exit %d: %s", code, out)
	}
}
