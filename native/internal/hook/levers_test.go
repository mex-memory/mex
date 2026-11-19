package hook

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/output"
)

func withEnv(env Env, extra map[string]string) Env {
	return func(k string) string {
		if v, ok := extra[k]; ok {
			return v
		}
		return env(k)
	}
}

func longTestRun() string {
	var b strings.Builder
	for i := 0; i < 600; i++ {
		fmt.Fprintf(&b, " ✓ src/cart.test.ts > case %d passes\n", i)
	}
	b.WriteString("stderr | Warning: something was not wrapped in act(...)\n")
	for i := 0; i < 100; i++ {
		fmt.Fprintf(&b, " ✓ src/orders.test.ts > case %d passes\n", i)
	}
	b.WriteString(" Tests  700 passed (700)\n")
	return b.String()
}

func claudeBash(t *testing.T, event, session, cwd, command, stdout string) []byte {
	t.Helper()
	body := map[string]any{"session_id": session, "cwd": cwd, "hook_event_name": event, "tool_name": "Bash", "tool_input": map[string]any{"command": command}}
	switch event {
	case "PostToolUse":
		body["tool_response"] = map[string]any{"stdout": stdout, "stderr": "", "interrupted": false, "isImage": false}
	case "PostToolUseFailure":
		body["error"] = "Exit code 1\n" + stdout
	}
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

type claudeReply struct {
	SystemMessage      string `json:"systemMessage"`
	HookSpecificOutput struct {
		PermissionDecision       string          `json:"permissionDecision"`
		PermissionDecisionReason string          `json:"permissionDecisionReason"`
		UpdatedInput             json.RawMessage `json:"updatedInput"`
		UpdatedToolOutput        json.RawMessage `json:"updatedToolOutput"`
	} `json:"hookSpecificOutput"`
}

func parseClaude(t *testing.T, out string) claudeReply {
	t.Helper()
	var r claudeReply
	if err := json.Unmarshal([]byte(out), &r); err != nil {
		t.Fatalf("reply %q: %v", out, err)
	}
	return r
}

// A long successful test run arrives trimmed, with the warning and the
// summary intact, and the full text is saved where `mex out` reads it.
func TestClaudeShellOutputTrimmedAndSaved(t *testing.T) {
	h, env := fakeHome(t, true)
	env = withEnv(env, map[string]string{"MEX_LEVERS": "on"})
	h = homeFrom(env)
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "on", "")
	full := longTestRun()
	_, out := run(t, []string{"claude-code", "PostToolUse"}, bytes.NewReader(claudeBash(t, "PostToolUse", "s1", root, "npm test", full)), env)
	r := parseClaude(t, out)
	var replaced struct {
		Stdout string `json:"stdout"`
		Stderr string `json:"stderr"`
	}
	if err := json.Unmarshal(r.HookSpecificOutput.UpdatedToolOutput, &replaced); err != nil {
		t.Fatalf("no replaced output: %s", out)
	}
	for _, want := range []string{"[MEX: output trimmed", "full text: mex out 1", "Warning: something was not wrapped", " Tests  700 passed (700)", "lines dropped"} {
		if !strings.Contains(replaced.Stdout, want) {
			t.Errorf("trimmed output lacks %q", want)
		}
	}
	if len(replaced.Stdout) >= len(full)/2 {
		t.Fatalf("barely trimmed: %d of %d", len(replaced.Stdout), len(full))
	}
	saved, err := os.ReadFile(filepath.Join(output.Directory(h.mex, projectID), "1.txt"))
	if err != nil || string(saved) != full {
		t.Fatalf("full output not saved byte for byte: %v", err)
	}
	var meta output.SavedMeta
	data, _ := os.ReadFile(filepath.Join(output.Directory(h.mex, projectID), "1.json"))
	if json.Unmarshal(data, &meta) != nil || meta.Command != "npm test" || meta.N != 1 || meta.Agent != "claude-code" {
		t.Fatalf("meta: %s", data)
	}
}

func TestClaudeShellOutputLeftWhole(t *testing.T) {
	full := longTestRun()
	cases := []struct {
		name    string
		env     map[string]string
		command string
		before  [][2]string // event, command run earlier in the session
		prompt  string
	}{
		{name: "explicit read", command: "cat test-output.log"},
		{name: "git diff", command: "git diff"},
		{name: "not a noisy command", command: "./print-everything.sh"},
		{name: "MEX_RAW in the environment", env: map[string]string{"MEX_RAW": "1"}, command: "npm test"},
		{name: "MEX_RAW in the command", command: "MEX_RAW=1 npm test"},
		{name: "reproducing a failure", command: "npm test", before: [][2]string{{"PostToolUseFailure", "npm test"}}},
		{name: "explicit whole output", command: "npm test", prompt: "Please show full output"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h, env := fakeHome(t, true)
			env = withEnv(env, map[string]string{"MEX_LEVERS": "on"})
			h = homeFrom(env)
			env = withEnv(env, c.env)
			root := repo(t, t.TempDir())
			register(t, h, root, projectID, "on", "")
			if c.prompt != "" {
				body, _ := json.Marshal(map[string]any{"session_id": "s1", "cwd": root, "hook_event_name": "UserPromptSubmit", "prompt": c.prompt})
				run(t, []string{"claude-code", "UserPromptSubmit"}, bytes.NewReader(body), env)
			}
			for _, b := range c.before {
				run(t, []string{"claude-code", b[0]}, bytes.NewReader(claudeBash(t, b[0], "s1", root, b[1], "boom")), env)
			}
			_, out := run(t, []string{"claude-code", "PostToolUse"}, bytes.NewReader(claudeBash(t, "PostToolUse", "s1", root, c.command, full)), env)
			if r := parseClaude(t, out); r.HookSpecificOutput.UpdatedToolOutput != nil {
				t.Fatalf("output replaced: %s", out)
			}
			if _, err := os.Stat(output.Directory(h.mex, projectID)); !os.IsNotExist(err) {
				t.Fatal("saved an output that was not trimmed")
			}
		})
	}
}

// Failures are left alone, and MEX off in a repo means nothing is trimmed.
func TestClaudeShellFailureAndOffRepoUntouched(t *testing.T) {
	h, env := fakeHome(t, true)
	env = withEnv(env, map[string]string{"MEX_LEVERS": "on"})
	h = homeFrom(env)
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "on", "")
	_, out := run(t, []string{"claude-code", "PostToolUseFailure"}, bytes.NewReader(claudeBash(t, "PostToolUseFailure", "s1", root, "npm test", longTestRun())), env)
	if strings.Contains(out, "updatedToolOutput") {
		t.Fatal(out)
	}
	off := repo(t, t.TempDir())
	register(t, h, off, "g-fedcba9876543210fedcba98", "off", "")
	_, out = run(t, []string{"claude-code", "PostToolUse"}, bytes.NewReader(claudeBash(t, "PostToolUse", "s2", off, "npm test", longTestRun())), env)
	assertEmptyReply(t, 0, out)
}

func TestClaudeSearchGroupsAndSavesOriginal(t *testing.T) {
	h, env := fakeHome(t, true)
	env = withEnv(env, map[string]string{"MEX_LEVERS": "on"})
	h = homeFrom(env)
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "on", "")
	original, err := os.ReadFile("../../output/testdata/outputs/grep-numbered.txt")
	if err != nil {
		t.Fatal(err)
	}
	_, out := run(t, []string{"claude-code", "PostToolUse"}, bytes.NewReader(claudeBash(t, "PostToolUse", "s1", root, "grep -rn needle src", string(original))), env)
	r := parseClaude(t, out)
	if !strings.Contains(string(r.HookSpecificOutput.UpdatedToolOutput), "search output grouped by file") {
		t.Fatalf("not grouped: %s", out)
	}
	saved, err := os.ReadFile(filepath.Join(output.Directory(h.mex, projectID), "1.txt"))
	if err != nil || !bytes.Equal(saved, original) {
		t.Fatal("original search output changed", err)
	}
}
