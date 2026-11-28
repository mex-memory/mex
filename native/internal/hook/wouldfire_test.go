package hook

import (
	"bytes"
	"encoding/json"
	"strings"
	"testing"
)

func TestWouldFireMode(t *testing.T) {
	rule := strings.Join([]string{"---", "mex:", "  id: mx_deepbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "  kind: rule", "  scope: [\"src/**\"]",
		"  source: {type: review, ref: \"https://github.com/acme/app/pull/2\", producer: learn-deeper}", "  evidence: review",
		"  one_line: Use the checked loader.", "  when:", "    - {type: anti, match: literal, pattern: \"rawLoad(\"}",
		"  checks:", "    - {kind: scope, role: complete, target: {glob: \"src/**\"}, saw: {count: 1}, files: {}}",
		"  status: active", "  created: 2026-11-23", "---", "Use the checked loader, not rawLoad.", ""}, "\n")
	input, _ := json.Marshal(map[string]any{"entries": []string{rule, "not an entry"}, "edits": []map[string]string{
		{"commit": "abc", "path": "src/x.ts", "added": "rawLoad(file)\n"}}})
	var out bytes.Buffer
	if code := wouldFire(bytes.NewReader(input), &out); code != 0 {
		t.Fatalf("exit %d: %s", code, out.String())
	}
	var reply struct {
		OK      bool                                   `json:"ok"`
		Matches []struct{ Entry, Commit, Path string } `json:"matches"`
	}
	if err := json.Unmarshal(out.Bytes(), &reply); err != nil || !reply.OK || len(reply.Matches) != 1 || reply.Matches[0].Commit != "abc" {
		t.Fatalf("reply %s", out.String())
	}
	out.Reset()
	if code := wouldFire(strings.NewReader("{"), &out); code != 2 {
		t.Fatalf("a bad request must fail, got %d", code)
	}
}
