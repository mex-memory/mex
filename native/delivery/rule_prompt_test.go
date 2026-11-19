package delivery

import (
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/internal/contract"
)

func TestRulePromptQuotesARuleStatedInPassing(t *testing.T) {
	ev := func(text string) contract.Event {
		return contract.Event{Kind: contract.Prompt, ProjectID: "p", SessionID: "s", Prompt: &contract.PromptIn{Text: text, Typed: true}}
	}
	line := RulePrompt(ev("We always use pnpm in this repo, never npm or yarn. Add lodash 4.17.21 to the dependencies."))
	if !strings.Contains(line, `the person said "We always use pnpm in this repo, never npm or yarn"`) || !strings.Contains(line, "mex note") {
		t.Fatal(line)
	}
	for _, quiet := range []string{
		"Add lodash to the dependencies and run the tests.", // a task, no rule
		"Should we always use pnpm here?",                   // a question
		"mex note: we always use pnpm",                      // the typed form saves itself
		"Run this:\n```\nnever_called()\n```",               // code is not a statement
		"Never mind.",                                       // too short to be a rule
	} {
		if got := RulePrompt(ev(quiet)); got != "" {
			t.Fatalf("%q: %s", quiet, got)
		}
	}
	off := ev("We always use pnpm in this repo.")
	off.ProjectID = ""
	if RulePrompt(off) != "" {
		t.Fatal("a repo with MEX off got the nudge")
	}
	machine := ev("We always use pnpm in this repo.")
	machine.Prompt.Typed = false
	if RulePrompt(machine) != "" {
		t.Fatal("a machine prompt got the nudge")
	}
}
