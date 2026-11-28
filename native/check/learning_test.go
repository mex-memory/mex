package check

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/delivery/entries"
)

func TestCurrentTriggersProveEveryFixture(t *testing.T) {
	pair := func(before, after string) map[string]any {
		return map[string]any{"before": map[string]any{"text": before}, "after": map[string]any{"text": after}}
	}
	target := map[string]any{
		"pairs":  []any{pair("loadRaw(input)", "loadSafe(input)"), pair("loadRaw(other)", "loadSafe(other)")},
		"proves": []any{0, 1},
	}
	ev, err := NewSnapshotEvaluator(nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, antiMatch, anti, required, want string
	}{
		{"literal", "literal", "loadRaw", "loadSafe($ARG)", Held},
		{"structural", "structural", "loadRaw($ARG)", "loadSafe($ARG)", Held},
		{"rewritten anti hits the fix", "literal", "load", "loadSafe($ARG)", Broken},
		{"required missing", "literal", "loadRaw", "validate($ARG)", Broken},
		{"only first pair proved", "literal", "loadRaw(input)", "loadSafe($ARG)", Broken},
	} {
		t.Run(tc.name, func(t *testing.T) {
			when := []entries.Trigger{
				{Type: "anti", Match: tc.antiMatch, Pattern: tc.anti},
				{Type: "required", Match: "structural", Pattern: tc.required},
			}
			r := ev.Evaluate(&Entry{Status: "active", When: when, Checks: []Check{{Kind: "fixture", Role: Complete, Target: target}}})
			if r.Verdict != tc.want || len(r.Inputs) != 0 {
				t.Fatalf("want %s with no file inputs: %+v", tc.want, r)
			}
			c, err := ev.Record("fixture", Complete, target, when...)
			if tc.want == Held && (err != nil || c.Saw["ok"] != true || len(c.Files) != 0) || tc.want == Broken && err == nil {
				t.Fatalf("record: %+v, %v", c, err)
			}
		})
	}
}

type testScopeIndex struct {
	*fakeIndex
	paths []string
}

func (f testScopeIndex) PathsMatching(string, int) ([]string, bool, error) {
	return f.paths, false, nil
}

func TestLearnedScopeAndPatternBaselines(t *testing.T) {
	root := t.TempDir()
	ix := &testScopeIndex{fakeIndex: &fakeIndex{counts: map[string]int{PatternID("loadRaw"): 2, PatternID("loadSafe"): 1}}, paths: []string{"src/load.ts"}}
	ev := evaluator(t, root)
	ev.UseIndex(ix)
	observe := func(kind, role string, target map[string]any) Check {
		t.Helper()
		c, err := ev.Record(kind, role, target)
		if err != nil {
			t.Fatal(err)
		}
		return c
	}
	scope := observe("scope", Complete, map[string]any{"glob": "src/**"})
	anti := observe("pattern", Supporting, map[string]any{"scope": "src/**", "pattern": "loadRaw", "expect": "at-most"})
	fix := observe("pattern", Complete, map[string]any{"scope": "src/**", "pattern": "loadSafe", "expect": "present"})
	e := &Entry{Status: "active", Checks: []Check{scope, anti, fix}}
	for _, tc := range []struct {
		name, want       string
		paths, anti, fix int
	}{
		{"unchanged", Held, 1, 2, 1},
		{"fewer anti matches", Held, 1, 1, 1},
		{"more anti matches", Changed, 1, 3, 1},
		{"fix removed", Broken, 1, 1, 0},
		{"scope gone", Broken, 0, 1, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ix.paths = []string{"src/load.ts"}[:tc.paths]
			ix.counts[PatternID("loadRaw")], ix.counts[PatternID("loadSafe")] = tc.anti, tc.fix
			if r := ev.Evaluate(e); r.Verdict != tc.want {
				t.Fatalf("want %s: %+v", tc.want, r)
			}
		})
	}
}

func TestLearnedExactScopeReadsTheDisk(t *testing.T) {
	root := t.TempDir()
	write(t, root, "src/context.ts", "export const context = 1\n")
	ix := &testScopeIndex{fakeIndex: &fakeIndex{counts: map[string]int{}}, paths: []string{"src/context.ts"}}
	ev := evaluator(t, root)
	ev.UseIndex(ix)
	scope, err := ev.Record("scope", Complete, map[string]any{"glob": "src/context.ts"})
	if err != nil {
		t.Fatal(err)
	}
	e := &Entry{Status: "active", Checks: []Check{scope}}
	if r := ev.Evaluate(e); r.Verdict != Held {
		t.Fatalf("the file is there: %+v", r)
	}
	// The team renames the file; the index hasn't caught up and still lists it.
	write(t, root, "src/ctx.ts", "export const context = 1\n")
	if err := os.Remove(filepath.Join(root, "src", "context.ts")); err != nil {
		t.Fatal(err)
	}
	// Each check run starts a fresh evaluator, as `mex check`, recall and the hook do.
	ev = evaluator(t, root)
	ev.UseIndex(ix)
	if r := ev.Evaluate(e); r.Verdict != Broken {
		t.Fatalf("a renamed exact scope must not hold from the index: %+v", r)
	}
}

func TestLearnedFixStaysInTheReviewedFile(t *testing.T) {
	root := t.TempDir()
	const file = "reviewed.ts"
	const fix = "return stableAdapter(input);"
	write(t, root, file, fix)
	c := record(t, root, "pattern", Complete, map[string]any{"scope": file, "pattern": fix, "match": "literal", "expect": "present"})
	write(t, root, "other.ts", fix)
	write(t, root, file, "// "+fix+"\nreturn stableAdapter(other);")
	if result := verdict(t, root, c); result.Verdict != Broken {
		t.Fatalf("another file, comment or caller should not hold the reviewed fix: %+v", result)
	}
}

func TestLearnedStructuralBaselineReadsTheReviewedFile(t *testing.T) {
	root := t.TempDir()
	const file = "reviewed.ts"
	write(t, root, file, "return stableAdapter(input);")
	c := record(t, root, "pattern", Supporting, map[string]any{"scope": file, "pattern": "legacyAdapter($X)", "match": "structural", "expect": "at-most"})
	write(t, root, file, "return legacyAdapter(input);")
	if result := verdict(t, root, c); result.Verdict != Changed {
		t.Fatalf("new structural match should change the verdict: %+v", result)
	}
}

func TestQuoteRelocation(t *testing.T) {
	const exact = "Use the checked loader for every request with input."
	root := t.TempDir()
	file := "CONTRIBUTING.md"
	write(t, root, file, "# Loader\n\n"+exact)
	c := record(t, root, "quote", Complete, map[string]any{"file": file, "exact": exact, "heading": "Loader", "prefix": "", "suffix": ""})
	if got := c.Saw["hash"]; got != textHash(exact) {
		t.Fatalf("quote hash: %v", got)
	}
	// The eight original pairs retain six across one edit and four across
	// separated edits. The 60% threshold distinguishes those cases.
	for _, tc := range []struct{ name, doc, want string }{
		{"unrelated changes", "# Loader\n\nUse the checked loader\nfor every request with input.\n# Notes\nExtra", Held},
		{"edited", "# Loader\n\nUse the safe loader for every request with input.", Changed},
		{"too little overlap", "# Loader\n\nUse the safe loader for every operation with input.", Broken},
		{"outside recorded heading", "# Loader\n\nDifferent instructions\n# Backup\n\nUse the safe loader for every request with input.", Broken},
		{"exact in obsolete sibling", "# Loader\n\nDifferent instructions\n# Obsolete\n\n" + exact, Broken},
		{"exact in obsolete child", "# Loader\n\nDifferent instructions\n## Obsolete\n\n" + exact, Broken},
		{"removed", "# Loader\n\nOnly send validated input.", Broken},
	} {
		t.Run(tc.name, func(t *testing.T) {
			write(t, root, file, tc.doc)
			r := verdict(t, root, c)
			if r.Verdict != tc.want {
				t.Fatalf("want %s: %+v", tc.want, r)
			}
			if tc.want == Changed && r.Checks[0].Reason != "the quoted passage was edited" {
				t.Fatalf("edited: %+v", r)
			}
		})
	}
	const repeated = "old start use safe input later new start use safe input now"
	if at := quoteOffset(repeated, "use safe input", "new start", "now"); at != strings.LastIndex(repeated, "use safe input") {
		t.Fatalf("selected offset %d", at)
	}
}

func TestUntilVersion(t *testing.T) {
	root := t.TempDir()
	for _, tc := range []struct{ value, version, want string }{
		{"4.10", "v5.0.0", Held},
		{"4.2", "4.10", Held},
		{"5.0-rc.2", "5.0.0", Held},
		{"5.0-rc.2", "5.0-rc.10", Held},
		{"5.0", "v5.0.0", Broken},
		{"5.0.0+build", "5.0", Broken},
		{"5.1", "5.0", Broken},
	} {
		t.Run(tc.value+" vs "+tc.version, func(t *testing.T) {
			write(t, root, "package.json", fmt.Sprintf(`{"version": %q}`, tc.value))
			target := map[string]any{"file": "package.json", "pointer": "/version", "version": tc.version}
			ev := evaluator(t, root)
			c := Check{Kind: "until", Role: Complete, Target: target}
			if r := ev.Evaluate(&Entry{Status: "active", Checks: []Check{c}}); r.Verdict != tc.want {
				t.Fatalf("want %s: %+v", tc.want, r)
			}
			observed, err := ev.Record("until", Complete, target)
			if tc.want == Held && (err != nil || observed.Saw["value"] != tc.value) || tc.want == Broken && err == nil {
				t.Fatalf("record: %+v, %v", observed, err)
			}
		})
	}
}

func TestURLSourceObservations(t *testing.T) {
	ev := evaluator(t, t.TempDir())
	const url = "https://github.com/example/repo/pull/1#discussion_r1"
	hash := hashBytes([]byte("source"))
	c := Check{Kind: "source", Role: Supporting, Target: map[string]any{"url": url}, Saw: map[string]any{"hash": hash}}
	for _, tc := range []struct {
		state, verdict string
		status         Status
	}{
		{"same", Held, Pass}, {"edited", Changed, Fail}, {"deleted", Changed, Gone}, {"", Unknown, Floor},
	} {
		t.Run(tc.state, func(t *testing.T) {
			ev.urlSource = func(got, captured string) (urlObservation, bool) {
				if got != url || captured != hash {
					t.Fatalf("asked for %s with %s", got, captured)
				}
				return urlObservation{State: tc.state, At: "2026-11-23T00:00:00Z"}, tc.state != ""
			}
			r := ev.Evaluate(&Entry{Status: "active", Checks: []Check{c}})
			if r.Verdict != tc.verdict || r.Checks[0].Status != tc.status {
				t.Fatalf("want %s/%s: %+v", tc.verdict, tc.status, r)
			}
		})
	}
}
