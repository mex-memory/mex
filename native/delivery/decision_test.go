package delivery

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/internal/contract"
)

func TestDecisionWordsAndCommitMessage(t *testing.T) {
	if got := DecisionWords("Switch to date-fns instead of moment"); !reflect.DeepEqual(got, []string{"instead of", "switch to"}) {
		t.Fatal(got)
	}
	if got := DecisionWords("Fix the dropdown"); len(got) != 0 {
		t.Fatal(got)
	}
	for command, want := range map[string]string{
		`git commit -m "Switch to pnpm instead of npm"`:                 "Switch to pnpm instead of npm",
		`git -C repo commit -am 'Drop yarn' -m "rather than keep both"`: "\n\nrather than keep both",
		`npm test && git commit --message="Adopt zod, avoid joi"`:       "Adopt zod, avoid joi",
		`git commit`:           "",
		`git log -m "x"`:       "",
		`echo git commit -m x`: "",
	} {
		if got := commitMessage(command); !strings.HasSuffix(got, want) || (want == "" && got != "") {
			t.Fatalf("%q -> %q", command, got)
		}
	}
}

func TestDecisionPromptOncePerSession(t *testing.T) {
	dir := t.TempDir()
	shell := func(session, command string) contract.Event {
		return contract.Event{Agent: "claude-code", Kind: contract.PostTool, SessionID: session, Tool: &contract.Tool{Name: contract.ToolShell, Input: contract.ToolInput{Command: command}}}
	}
	if DecisionPrompt(shell("s1", `git commit -m "Fix typo"`), dir) != "" {
		t.Fatal("prompted for a commit with no decision words")
	}
	if line := DecisionPrompt(shell("s1", `git commit -m "Switch to date-fns instead of moment"`), dir); !strings.Contains(line, "mex note --decision --commit HEAD") {
		t.Fatal(line)
	}
	if DecisionPrompt(shell("s1", `git commit -m "Adopt zod rather than joi"`), dir) != "" {
		t.Fatal("prompted twice in one session")
	}
	sub := shell("s2", `git commit -m "Adopt zod rather than joi"`)
	sub.AgentID = "sub"
	if DecisionPrompt(sub, dir) != "" {
		t.Fatal("prompted a subagent")
	}
	// Session start: the background process noted a decision commit.
	sha := strings.Repeat("a", 40)
	if err := os.MkdirAll(filepath.Join(dir, "decision-commits"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "decision-commits", "g-0123456789abcdef01234567.json"), []byte(`{"version":1,"sha":"`+sha+`","words":["instead of","switch to"]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	start := func(session string) contract.Event {
		return contract.Event{Agent: "codex", Kind: contract.SessionStart, SessionID: session, ProjectID: "g-0123456789abcdef01234567"}
	}
	if line := DecisionPrompt(start("s3"), dir); !strings.Contains(line, "--commit aaaaaaa") {
		t.Fatal(line)
	}
	if DecisionPrompt(start("s4"), dir) != "" {
		t.Fatal("the same commit was offered in a second session")
	}
}
