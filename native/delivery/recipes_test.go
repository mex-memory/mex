package delivery

import (
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/internal/contract"
)

// The recorded generator case from the earlier replay: after changes in one
// folder, run its scripts. It fires at the first edit there, one line only.
const generatorLine = "After changes in internal/fourslash, run `npm run convertfourslash`, then the tests, then `npm run updatefailing`."

func generatorRecipe(f *fixture, extra ...func(*spec)) {
	s := spec{id: "mx_fourgen", kind: "procedure", scope: "internal/fourslash/**", source: "review", evidence: "review", ref: "https://example.invalid/pr/1",
		oneLine: generatorLine,
		text:    generatorLine + " The generated tests and failingTests.txt must match the converter, and CI checks both, so a change that skips them fails later."}
	for _, e := range extra {
		e(&s)
	}
	f.entry(s)
}

func editDone(f *fixture, rel, text string) contract.Tool {
	tool := edited(f, rel, "x", text)
	tool.Output = &contract.ToolOutput{Text: "ok", OK: true}
	return tool
}

func TestMomentRecipeAtTheFirstEditInItsArea(t *testing.T) {
	f := newFixture(t)
	generatorRecipe(f)
	f.start("startup")
	out := f.send(f.event(contract.PostToolBatch, editDone(f, "internal/fourslash/tests/a_test.go", "y")))
	if !strings.Contains(out, "npm run updatefailing") {
		t.Fatalf("no recipe at the first edit: %q", out)
	}
	if strings.Contains(out, "CI checks both") {
		t.Fatalf("a moment recipe goes in its one-line form: %q", out)
	}
	if tok := entries.EstimateTokens(generatorLine); tok > 45 {
		t.Fatalf("the fixture's one line is %d tokens", tok)
	}
	// Only the first edit in the area, this epoch.
	if out := f.send(f.event(contract.PostToolBatch, editDone(f, "internal/fourslash/tests/b_test.go", "y"))); strings.Contains(out, "updatefailing") {
		t.Fatalf("sent twice: %q", out)
	}
}

func TestMomentRecipeStaysOutsideItsArea(t *testing.T) {
	cases := map[string]struct {
		rule func(*spec)
		rel  string
	}{
		"an edit elsewhere":       {rel: "internal/checker/checker.go"},
		"a repo-wide procedure":   {rule: func(s *spec) { s.scope = "**" }, rel: "internal/fourslash/a.go"},
		"a new-file procedure":    {rule: func(s *spec) { s.when = []string{"creates:internal/fourslash/tests/gen/*.go"} }, rel: "internal/fourslash/a.go"},
		"a rule, not a procedure": {rule: func(s *spec) { s.kind = "rule" }, rel: "internal/fourslash/a.go"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t)
			if c.rule != nil {
				generatorRecipe(f, c.rule)
			} else {
				generatorRecipe(f)
			}
			f.start("startup")
			if out := f.send(f.event(contract.PostToolBatch, editDone(f, c.rel, "y"))); strings.Contains(out, "updatefailing") {
				t.Fatalf("fired: %q", out)
			}
		})
	}
}
