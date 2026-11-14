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
