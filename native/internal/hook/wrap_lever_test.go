package hook

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/internal/adapter/codex"
	"github.com/mex-memory/mex/native/output"
)

type codexReply struct {
	HookSpecificOutput struct {
		PermissionDecision string          `json:"permissionDecision"`
		UpdatedInput       json.RawMessage `json:"updatedInput"`
	} `json:"hookSpecificOutput"`
}

func codexPre(t *testing.T, root string, input map[string]any) []byte {
	t.Helper()
	b, _ := json.Marshal(map[string]any{"session_id": "c1", "turn_id": "t1", "cwd": root, "hook_event_name": "PreToolUse", "permission_mode": "default", "tool_name": "Bash", "tool_use_id": "call_1", "tool_input": input})
	return b
}

func codexSetup(t *testing.T) (home, Env, string) {
	t.Helper()
	h, env := fakeHome(t, true)
	env = withEnv(env, map[string]string{"SHELL": "/bin/bash"})
	h = homeFrom(env)
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "on", "")
	return h, env, root
}

func TestCodexWrapsASimpleNoisyCommand(t *testing.T) {
	_, env, root := codexSetup(t)
	for _, input := range []map[string]any{
		{"command": "npm test"},
		{"command": []string{"bash", "-lc", "npm test"}},
		{"command": "npm test", "workdir": root, "sandbox_permissions": "use_default"},
	} {
		_, out := run(t, []string{"codex", "PreToolUse"}, bytes.NewReader(codexPre(t, root, input)), env)
		var r codexReply
		if json.Unmarshal([]byte(out), &r) != nil || r.HookSpecificOutput.PermissionDecision != "allow" {
			t.Fatalf("%v: not wrapped: %s", input, out)
		}
		var updated map[string]any
		if json.Unmarshal(r.HookSpecificOutput.UpdatedInput, &updated) != nil {
			t.Fatal(out)
		}
		command, _ := updated["command"].(string)
		if argv, ok := updated["command"].([]any); ok {
			if len(argv) != 3 || argv[0] != "bash" || argv[1] != "-lc" {
				t.Fatalf("argv form not kept: %v", argv)
			}
			command, _ = argv[2].(string)
		}
		original, shell, ok := output.Unwrap(command)
		want := "bash"
		if runtime.GOOS == "windows" {
			want = "powershell"
		}
		if !ok || original != "npm test" || shell != want {
			t.Fatalf("rewritten command %q", command)
		}
		for k, v := range input {
			if k != "command" && updated[k] != v {
				t.Fatalf("lost %s", k)
			}
		}
	}
}

func TestCodexNeverWraps(t *testing.T) {
	cases := map[string]struct {
		input map[string]any
		setup func(t *testing.T, h home, root string)
		env   map[string]string
	}{
		"a pipe":                  {input: map[string]any{"command": "npm test | tail -5"}},
		"a redirect":              {input: map[string]any{"command": "npm test > out.log"}},
		"a heredoc":               {input: map[string]any{"command": "cat <<EOF\nx\nEOF"}},
		"a background run":        {input: map[string]any{"command": "npm test &"}},
		"a list":                  {input: map[string]any{"command": "npm ci && npm test"}},
		"substitution":            {input: map[string]any{"command": "npm test -- $(cat list)"}},
		"sudo":                    {input: map[string]any{"command": "sudo npm install -g x"}},
		"a quiet command":         {input: map[string]any{"command": "git status"}},
		"an explicit read":        {input: map[string]any{"command": "cat package.json"}},
		"git diff":                {input: map[string]any{"command": "git diff"}},
		"leaving the sandbox":     {input: map[string]any{"command": "npm install", "sandbox_permissions": "require_escalated", "justification": "network"}},
		"escalated (older form)":  {input: map[string]any{"command": "npm install", "with_escalated_permissions": true}},
		"an unknown input field":  {input: map[string]any{"command": "npm test", "prefix_rule": []string{"npm"}}},
		"already wrapped":         {input: map[string]any{"command": output.Wrap("/x/mex-hook", "bash", "npm test")}},
		"MEX_RAW":                 {input: map[string]any{"command": "npm test"}, env: map[string]string{"MEX_RAW": "1"}},
		"a shell MEX can't quote": {input: map[string]any{"command": "npm test"}, env: map[string]string{"SHELL": "/usr/bin/fish"}},
		"a user rule names it": {input: map[string]any{"command": "npm test --watch=false"}, setup: func(t *testing.T, h home, root string) {
			write(t, filepath.Join(h.codex, "rules", "default.rules"), "prefix_rule(\n    pattern = [\"npm\", [\"test\", \"run\"]],\n    decision = \"allow\",\n)\n")
		}},
		"a project rule names it": {input: map[string]any{"command": "cargo build"}, setup: func(t *testing.T, h home, root string) {
			write(t, filepath.Join(root, ".codex", "rules", "x.rules"), `prefix_rule(pattern=["cargo"], decision="prompt")`)
		}},
		"an unreadable rules file": {input: map[string]any{"command": "npm test"}, setup: func(t *testing.T, h home, root string) {
			write(t, filepath.Join(h.codex, "rules", "odd.rules"), "prefix_rule(pattern = CONSTANT)")
		}},
		"the untrusted policy": {input: map[string]any{"command": "npm test"}, setup: func(t *testing.T, h home, root string) {
			write(t, filepath.Join(h.codex, "config.toml"), "approval_policy = \"untrusted\"\n")
		}},
		"reproducing a failure": {input: map[string]any{"command": "npm test"}, setup: func(t *testing.T, h home, root string) {
			b, _ := json.Marshal(map[string]any{"session_id": "c1", "turn_id": "t0", "cwd": root, "hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": map[string]any{"command": "npm test"}, "tool_response": "Exit code: 1\nWall time: 1 seconds\nOutput:\nfailed\n"})
			run(t, []string{"codex", "PostToolUse"}, bytes.NewReader(b), homeEnv(h))
		}},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			h, env, root := codexSetup(t)
			if c.setup != nil {
				c.setup(t, h, root)
			}
			_, out := run(t, []string{"codex", "PreToolUse"}, bytes.NewReader(codexPre(t, root, c.input)), withEnv(env, c.env))
			if strings.Contains(out, "updatedInput") || strings.Contains(out, `"allow"`) {
				t.Fatalf("wrapped: %s", out)
			}
		})
	}
	// A rule that names another command doesn't stop this one.
	h, env, root := codexSetup(t)
	write(t, filepath.Join(h.codex, "rules", "default.rules"), "prefix_rule(pattern = [\"git\", \"push\"], decision = \"prompt\")\n# a comment\n")
	_, out := run(t, []string{"codex", "PreToolUse"}, bytes.NewReader(codexPre(t, root, map[string]any{"command": "npm test"})), env)
	if !strings.Contains(out, "updatedInput") {
		t.Fatalf("an unrelated rule stopped the wrapper: %s", out)
	}
}

func homeEnv(h home) Env {
	return func(k string) string {
		switch k {
		case "HOME", "USERPROFILE":
			return h.user
		case "SHELL":
			return "/bin/bash"
		}
		return ""
	}
}

// Claude Code's commands are never rewritten.
func TestClaudeCommandsNeverRewritten(t *testing.T) {
	h, env := fakeHome(t, true)
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "on", "")
	b, _ := json.Marshal(map[string]any{"session_id": "s1", "cwd": root, "hook_event_name": "PreToolUse", "tool_name": "Bash", "tool_input": map[string]any{"command": "npm test"}})
	_, out := run(t, []string{"claude-code", "PreToolUse"}, bytes.NewReader(b), env)
	assertEmptyReply(t, 0, out)
}

// After it ran, a wrapped command is seen as the original: moments and
// capture see `npm test`, not the wrapper.
func TestCodexSeesTheOriginalAfterTheWrapperRan(t *testing.T) {
	line := output.Wrap("/home/dev/.mex/bin/mex-hook", "bash", "npm test")
	b, _ := json.Marshal(map[string]any{"session_id": "c1", "cwd": "/repo", "hook_event_name": "PostToolUse", "tool_name": "Bash", "tool_input": map[string]any{"command": line}, "tool_response": "Exit code: 1\nWall time: 1 seconds\nOutput:\n$ npm test\nfailed\n"})
	ev, err := codex.Profile{}.Parse("PostToolUse", b)
	if err != nil || ev.Tool.Input.Command != "npm test" || ev.Tool.Output.OK {
		t.Fatalf("%+v %v", ev.Tool, err)
	}
	pre, _ := codex.Profile{}.Parse("PreToolUse", codexPre(t, "/repo", map[string]any{"command": line}))
	if pre.Tool.Input.Command != line {
		t.Fatal("PreToolUse must see what is about to run")
	}
}

// The wrapper through the real entry point: the command runs, its exit code
// comes back, and a long success is trimmed with its full text saved.
func TestWrapperThroughRun(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell syntax")
	}
	h, env, root := codexSetup(t)
	wd, _ := os.Getwd()
	if err := os.Chdir(root); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(wd)
	var out bytes.Buffer
	code := Run([]string{"run", "--shell", "sh", "--", "echo nope; exit 7"}, nil, &out, &out, env)
	if code != 7 || !strings.HasPrefix(out.String(), "$ echo nope; exit 7\n") {
		t.Fatalf("%d %q", code, out.String())
	}
	out.Reset()
	long := `find . -name no-such-file; i=0; while [ $i -lt 700 ]; do echo " - case $i passes"; i=$((i+1)); done; echo "src/a.test.ts:3 warning"`
	if code := Run([]string{"run", "--shell", "sh", "--", long}, nil, &out, &out, env); code != 0 {
		t.Fatalf("%d %s", code, out.String())
	}
	if !strings.Contains(out.String(), "full text: mex out 1") || !strings.Contains(out.String(), "src/a.test.ts:3 warning") {
		t.Fatalf("not trimmed: %.500s", out.String())
	}
	saved, err := os.ReadFile(filepath.Join(output.Directory(h.mex, projectID), "1.txt"))
	if err != nil || !strings.Contains(string(saved), " - case 350 passes") {
		t.Fatal("full text not saved")
	}
	// Bad usage never runs anything.
	if code := Run([]string{"run", "--shell", "fish", "--", "true"}, nil, &out, &out, env); code != 2 {
		t.Fatal(code)
	}
}
