package capture

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/internal/contract"
)

func prompt(text string) contract.Event {
	return contract.Event{Agent: "claude-code", Kind: contract.Prompt, SessionID: "s", Prompt: &contract.PromptIn{Text: text, Typed: true}}
}

func shell(kind contract.Kind, agent, command string, out *contract.ToolOutput) contract.Event {
	return contract.Event{Agent: agent, Kind: kind, SessionID: "s", Tool: &contract.Tool{Name: contract.ToolShell, Input: contract.ToolInput{Command: command}, Output: out}}
}

func env(vars map[string]string) func(string) string {
	return func(k string) string { return vars[k] }
}

func TestRowsKeepOnlyTypedTextAndCommands(t *testing.T) {
	two := 2
	cases := []struct {
		name string
		ev   contract.Event
		want string // kind:text:exit, or "" for nothing
	}{
		{"typed", prompt("use pnpm here"), "typed:use pnpm here:-"},
		{"blank prompt", prompt("  \n"), ""},
		{"claude success", shell(contract.PostTool, "claude-code", "npm test", &contract.ToolOutput{Text: "all passed: secret output", OK: true}), "command:npm test:0"},
		{"claude failure", shell(contract.PostToolFailure, "claude-code", "npm test", &contract.ToolOutput{Text: "Exit code 2\nboom", ExitCode: &two}), "command:npm test:2"},
		{"codex no code", shell(contract.PostTool, "codex", "ls", &contract.ToolOutput{Text: "a b", OK: true}), "command:ls:-"},
		{"not a shell", contract.Event{Agent: "claude-code", Kind: contract.PostTool, SessionID: "s", Tool: &contract.Tool{Name: contract.ToolWrite, Input: contract.ToolInput{Path: "/a", Content: ptr("file contents")}}}, ""},
		{"batch is never journaled", contract.Event{Agent: "claude-code", Kind: contract.PostToolBatch, SessionID: "s", Batch: []contract.Tool{{Name: contract.ToolShell, Input: contract.ToolInput{Command: "npm test"}}}}, ""},
		{"stop carries agent text only", contract.Event{Agent: "claude-code", Kind: contract.Stop, SessionID: "s"}, ""},
	}
	for _, c := range cases {
		rows := Rows(c.ev, Env{})
		got := ""
		if len(rows) == 1 {
			code := "-"
			if rows[0].ExitCode != nil {
				code = string(rune('0' + *rows[0].ExitCode))
			}
			got = rows[0].Kind + ":" + rows[0].Text + ":" + code
		} else if len(rows) > 1 {
			t.Fatalf("%s: %d rows", c.name, len(rows))
		}
		if got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
		for _, r := range rows {
			if strings.Contains(r.Text, "output") || strings.Contains(r.Text, "contents") {
				t.Errorf("%s: tool output or file contents saved", c.name)
			}
		}
	}
}

func TestSubagentsTypeNothing(t *testing.T) {
	ev := prompt("hello")
	ev.AgentID = "sub-1"
	if rows := Rows(ev, Env{}); rows != nil {
		t.Fatal(rows)
	}
	cmd := shell(contract.PostToolFailure, "claude-code", "npm test", &contract.ToolOutput{})
	cmd.AgentID = "sub-1"
	if rows := Rows(cmd, Env{}); rows != nil {
		t.Fatal(rows)
	}
}

func TestMarks(t *testing.T) {
	typed := prompt("rename the flag")
	if m := Marks(typed, env(nil)); m != "" {
		t.Fatal(m)
	}
	if m := Marks(typed, env(map[string]string{"CLAUDE_CODE_ENTRYPOINT": "sdk-ts"})); m != "scripted" {
		t.Fatal(m)
	}
	if m := Marks(typed, env(map[string]string{"CLAUDE_CODE_ENTRYPOINT": "cli"})); m != "" {
		t.Fatal(m)
	}
	if m := Marks(typed, env(map[string]string{"CI": "true"})); m != "scripted" {
		t.Fatal(m)
	}
	if m := Marks(typed, env(map[string]string{"CI": "0"})); m != "" {
		t.Fatal(m)
	}
	trace := prompt("why does this fail?\nTraceback (most recent call last):\n  File \"a.py\", line 3, in <module>\n    main()\n  File \"a.py\", line 2, in main\nValueError: x")
	if m := Marks(trace, env(map[string]string{"GITHUB_ACTIONS": "true"})); m != "pasted,scripted" {
		t.Fatal(m)
	}
	notTyped := prompt("short")
	notTyped.Prompt.Typed = false
	if m := Marks(notTyped, env(nil)); m != "pasted" {
		t.Fatal(m)
	}
}

func TestPasted(t *testing.T) {
	typed := []string{
		"no, not that one; use the other config",
		"run the tests again with -v",
		"let's not do that for now, the API is changing",
		"fix src/a.ts:12:3 please",
		"```\nnpm test\n```",
	}
	pasted := []string{
		strings.Repeat("word ", 400),
		strings.Repeat("line\n", 25),
		"TypeError: x is undefined\n    at foo (/app/a.js:10:5)\n    at bar (/app/b.js:2:1)",
		"diff --git a/x b/x\n@@ -1,2 +1,2 @@\n-a\n+b",
		"2026-11-14 10:00:01 start\n2026-11-14 10:00:02 load\n2026-11-14 10:00:03 fail",
		"src/a.ts:1:2: error TS2322\nsrc/b.ts:4:5: error TS2345",
		"look:\n```\na\nb\nc\nd\ne\n```",
	}
	for _, s := range typed {
		if Pasted(s) {
			t.Errorf("typed text marked pasted: %q", s)
		}
	}
	for _, s := range pasted {
		if !Pasted(s) {
			t.Errorf("pasted text not marked: %q", s)
		}
	}
}

func TestRedactKeepsTheRowWithoutTheSecret(t *testing.T) {
	cases := map[string]string{
		"deploy with token=abcd1234efgh5678":                              "deploy with token=" + Redacted,
		"export GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123":          "export GITHUB_TOKEN=" + Redacted,
		"curl -H 'Authorization: Bearer abcdefghijklmnop1234' x":          "curl -H 'Authorization: Bearer " + Redacted + "' x",
		"git clone https://me:hunter2pass@example.com/r.git":              "git clone https://me:" + Redacted + "@example.com/r.git",
		"key AKIAABCDEFGHIJKLMNOP here":                                   "key " + Redacted + " here",
		"-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY----- ok":  Redacted + " ok",
		"use mexi_0123456789abcdef as the producer token":                 "use " + Redacted + " as the producer token",
		"nothing secret about max_tokens=4096":                            "nothing secret about max_tokens=4096",
		"DB_PASSWORD=hunter2hunter2 go test ./...":                        "DB_PASSWORD=" + Redacted + " go test ./...",
		"STRIPE_API_KEY=sk_live_abcdefghijklmnop1234 cargo test":          "STRIPE_API_KEY=" + Redacted + " cargo test",
		"NPM_TOKEN=npm_abcdefgh12345678 npm ci":                           "NPM_TOKEN=" + Redacted + " npm ci",
		"PGPASSWORD=s3cretPassw0rd psql":                                  "PGPASSWORD=" + Redacted + " psql",
		"DATABASE_URL=postgres://app:s3cretPassw0rd@db:5432/app npm test": "DATABASE_URL=postgres://app:" + Redacted + "@db:5432/app npm test",
		"redis-cli -u redis://:s3cretPassw0rd@localhost:6379":             "redis-cli -u redis://:" + Redacted + "@localhost:6379",
		// Ordinary words and settings that only look close stay.
		"KEYBOARD=us-international-layout make build":            "KEYBOARD=us-international-layout make build",
		"SORT_KEY=createdAtDescending npm test":                  "SORT_KEY=createdAtDescending npm test",
		"PASSWORD_FILE=/run/secrets/database npm test":           "PASSWORD_FILE=/run/secrets/database npm test",
		"pass --password-file ./secrets.txt to passthrough mode": "pass --password-file ./secrets.txt to passthrough mode",
		"DATABASE_URL=postgres://localhost:5432/app npm test":    "DATABASE_URL=postgres://localhost:5432/app npm test",
		"git clone ssh://git@github.com:22/org/repo.git":         "git clone ssh://git@github.com:22/org/repo.git",
	}
	for in, want := range cases {
		if got := Redact(in); got != want {
			t.Errorf("Redact(%q) = %q, want %q", in, got, want)
		}
	}
	rows := Rows(prompt("my password: supersecret99 stop leaking it"), Env{})
	if len(rows) != 1 || strings.Contains(rows[0].Text, "supersecret99") || !strings.Contains(rows[0].Text, "stop leaking it") {
		t.Fatal(rows)
	}
}

func TestRowsAreBounded(t *testing.T) {
	rows := Rows(prompt(strings.Repeat("é", MaxTyped)), Env{})
	if len(rows) != 1 || len(rows[0].Text) > MaxTyped || !strings.HasSuffix(rows[0].Text, "é") {
		t.Fatal(len(rows[0].Text))
	}
	rows = Rows(shell(contract.PostTool, "claude-code", strings.Repeat("x", 10000), &contract.ToolOutput{OK: true}), Env{})
	if len(rows[0].Text) != MaxCommand {
		t.Fatal(len(rows[0].Text))
	}
}

func TestNoteCommand(t *testing.T) {
	cases := map[string]string{
		"mex note: tests need Docker running":    "tests need Docker running",
		"  MEX NOTE:   use pnpm, not npm  ":      "use pnpm, not npm",
		"mex note:":                              "",
		"please mex note: this":                  "",
		"mex notes: this":                        "",
		"mex note: " + strings.Repeat("x", 5000): "",
	}
	for in, want := range cases {
		got, ok := NoteCommand(prompt(in), nil)
		if got != want || ok != (want != "") {
			t.Errorf("%q: got %q %v", in, got, ok)
		}
	}
	scripted := prompt("mex note: from CI")
	if _, ok := NoteCommand(scripted, env(map[string]string{"CI": "1"})); ok {
		t.Fatal("scripted prompt saved a note")
	}
	sub := prompt("mex note: x")
	sub.AgentID = "a"
	if _, ok := NoteCommand(sub, nil); ok {
		t.Fatal("subagent saved a note")
	}
}

func ptr(s string) *string { return &s }

func TestEditRowsArePathsInTheCheckout(t *testing.T) {
	root := t.TempDir()
	at := func(parts ...string) string {
		return filepath.ToSlash(filepath.Join(append([]string{root}, parts...)...))
	}
	edit := func(kind contract.Kind, tool contract.Tool) contract.Event {
		if tool.Output == nil {
			tool.Output = &contract.ToolOutput{OK: kind == contract.PostTool}
		}
		return contract.Event{Agent: "codex", Kind: kind, SessionID: "s", Checkout: root, Cwd: root, Tool: &tool}
	}
	long := at(strings.Repeat("d/", MaxEditPath/2), "x.go")
	patch := contract.Tool{Name: contract.ToolPatch, Input: contract.ToolInput{Files: []contract.PatchFile{
		{Path: at("a.go")}, {Path: at("a.go")}, {Path: at("b", "c.go")}, {Path: long}, {Path: at("token=abcdefgh12345678.txt")}, {Path: filepath.ToSlash(filepath.Dir(root)) + "/out.go"},
	}}}
	cases := []struct {
		name string
		ev   contract.Event
		want string
	}{
		{"patch: once per file, inside the checkout, no long or secret paths", edit(contract.PostTool, patch), "a.go,b/c.go"},
		{"write", edit(contract.PostTool, contract.Tool{Name: contract.ToolWrite, Input: contract.ToolInput{Path: at("w.md"), Content: ptr("body")}}), "w.md"},
		{"failed", edit(contract.PostToolFailure, contract.Tool{Name: contract.ToolEdit, Input: contract.ToolInput{Path: at("e.go")}}), ""},
		{"interrupted", edit(contract.PostTool, contract.Tool{Name: contract.ToolEdit, Input: contract.ToolInput{Path: at("e.go")}, Output: &contract.ToolOutput{OK: true, Interrupted: true}}), ""},
		{"the checkout itself", edit(contract.PostTool, contract.Tool{Name: contract.ToolWrite, Input: contract.ToolInput{Path: at()}}), ""},
		{"multi-edit is Claude Code's only", edit(contract.PostTool, contract.Tool{Name: contract.ToolOther, RawName: "MultiEdit", RawInput: []byte(`{"file_path":"m.go"}`)}), ""},
	}
	claude := edit(contract.PostTool, contract.Tool{Name: contract.ToolOther, RawName: "NotebookEdit", RawInput: []byte(`{"notebook_path":"nb/a.ipynb","new_source":"body"}`)})
	claude.Agent = "claude-code"
	cases = append(cases, struct {
		name string
		ev   contract.Event
		want string
	}{"notebook edit", claude, "nb/a.ipynb"})
	sub := edit(contract.PostTool, contract.Tool{Name: contract.ToolWrite, Input: contract.ToolInput{Path: at("w.md")}})
	sub.AgentID = "sub-1"
	cases = append(cases, struct {
		name string
		ev   contract.Event
		want string
	}{"subagent", sub, ""})
	for _, c := range cases {
		var got []string
		for _, r := range Rows(c.ev, Env{}) {
			if r.Kind != "edit" || r.ExitCode != nil || r.Marks != "" {
				t.Fatalf("%s: %+v", c.name, r)
			}
			got = append(got, r.Text)
		}
		if strings.Join(got, ",") != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}
