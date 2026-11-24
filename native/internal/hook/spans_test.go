package hook

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/index/shift"
)

func TestCodexSearchSpanThroughHook(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "adapter", "codex", "testdata", "payloads", "PostToolUse-Bash-recorded2.json"))
	if err != nil {
		t.Fatal(err)
	}
	h, env := fakeHome(t, true)
	env = withEnv(env, map[string]string{"MEX_DELIVERY_SURFACES": "{\"search-span\":\"on\"}"})
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "on", "")
	const source = "export function add(a, b) {\n  return a + b;\n}\n"
	write(t, filepath.Join(root, "math.js"), source)
	fakeIndex(t, h.mex, projectID, root, "math.js", []byte(source), []shift.Symbol{{Name: "add", Kind: "function", Start: 1, End: 3}})

	const match = "math.js:1:export function add(a, b) {\r\n"
	const header = "\nWall time: 0.1 seconds\nOutput:\n"
	for _, tc := range []struct {
		name, output string
		card         bool
	}{
		{"recorded missing rg", "", false},
		{"headerless match", match, true},
		{"exit one", "Exit code: 1" + header, true},
		{"exit two", "Exit code: 2" + header + match, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var payload map[string]any
			if err := json.Unmarshal(raw, &payload); err != nil {
				t.Fatal(err)
			}
			payload["cwd"] = root
			payload["session_id"] = tc.name
			delete(payload, "transcript_path")
			if tc.output != "" {
				payload["tool_input"] = map[string]string{"command": "rg -n -H add math.js"}
				payload["tool_response"] = tc.output
			}
			body, err := json.Marshal(payload)
			if err != nil {
				t.Fatal(err)
			}
			code, out := run(t, []string{"codex", "PostToolUse"}, bytes.NewReader(body), env)
			t.Logf("exit %d, reply %s", code, strings.TrimSpace(out))
			if !tc.card {
				assertEmptyReply(t, code, out)
			} else if code != 0 || !json.Valid([]byte(out)) || !strings.Contains(out, "return a + b;") || !strings.Contains(out, "\"additionalContext\"") {
				t.Fatalf("no card: exit %d, reply %s", code, out)
			}
		})
	}
}
