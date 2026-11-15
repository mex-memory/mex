package delivery

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/record"
)

func scored(id string, tier int, ev, scope string, tokens int) shaped {
	it := &entries.Item{Entry: &entries.Entry{ID: id, Evidence: ev, Scope: []string{scope}, Source: entries.Source{Type: "docs"}}, Level: "team"}
	return shaped{candidate: candidate{item: it, tier: tier}, lineTok: tokens, fullTok: tokens, full: id, oneLine: id, action: "given"}
}
func TestTiersLexicographicAndMonotone(t *testing.T) {
	items := []shaped{
		scored("id", tierPattern, "person", "src/core/a.ts", 10),
		scored("id", tierPattern, "person", "src/core/a.ts", 600),
		scored("id", tierPattern, "person", "src/a.ts", 1),
		scored("id", tierPattern, "person", "src/*.ts", 1),
		scored("id", tierPattern, "person", "src/**", 1),
		scored("id", tierPattern, "person", "**", 1),
		scored("id", tierPattern, "ci", "src/core/a.ts", 1),
		scored("id", tierPattern, "observed", "**", 600),
		scored("id", tierCommand, "person", "src/core/a.ts", 1),
		scored("id", tierCommand, "observed", "**", 600),
		scored("id", tierFile, "person", "src/core/a.ts", 1),
		scored("id", tierFolder, "person", "src/**", 1),
		scored("id", tierPrompt, "person", "**", 1),
	}
	s := tiersScorer{}
	for i := 1; i < len(items); i++ {
		a, b := items[i-1], items[i]
		if !s.Less(a, b) || s.Value(a, a.lineTok) <= s.Value(b, b.lineTok) {
			t.Fatalf("order %d: %g <= %g", i, s.Value(a, a.lineTok), s.Value(b, b.lineTok))
		}
	}
	personal := scored("p", tierFile, "observed", "src/a.ts", 10)
	personal.item.Level = "personal"
	personal.item.Entry.Source.Type = "person"
	if evidence(personal) != 6 {
		t.Fatal("person note lost its evidence")
	}
	a, b := scored("a", tierFile, "docs", "**", 10), scored("b", tierFile, "docs", "**", 10)
	if !s.Less(a, b) || s.Value(a, 10) != s.Value(b, 10) {
		t.Fatal("ID tie")
	}
	if s.Value(scored("weak", tierCommand, "observed", "**", 600), 600) < bar(0) {
		t.Fatal("initial command rejected")
	}
	small := scored("small", tierPattern, "person", "src/a.ts", 10)
	large := scored("large", tierPattern, "person", "src/a.ts", 600)
	if s.Value(small, 10) < bar(1) || s.Value(large, 600) >= bar(1) {
		t.Fatal("saturation boundary lost size distinction")
	}
	for z := 0.0; z < 1; z += .01 {
		if bar(z) >= bar(z+.01) {
			t.Fatal("bar did not rise")
		}
	}
	if bar(-1) != bar(0) || bar(2) != bar(1) {
		t.Fatal("bar clamps")
	}
}
func TestScorersDeterministicAndBaselinesIndependent(t *testing.T) {
	a := scored("a", tierPattern, "person", "src/a.ts", 10)
	b := scored("b", tierFolder, "observed", "src/**", 10)
	a.item.Entry.OneLine = "Cache storage transactions"
	b.item.Entry.OneLine = "Run compiler compilation checks"
	snap := &entries.Snapshot{Items: []entries.Item{*b.item, *a.item}}
	for _, name := range []string{"tiers", "bm25", "fcfs", "risk"} {
		t.Run(name, func(t *testing.T) {
			var first []string
			for n := 0; n < 20; n++ {
				items := []shaped{a, b}
				if n%2 == 0 {
					items[0], items[1] = items[1], items[0]
				}
				s := newScorer(name, "compiler compilation", snap, items, nil)
				sort.SliceStable(items, func(i, j int) bool { return s.Less(items[i], items[j]) })
				ids := []string{items[0].item.Entry.ID, items[1].item.Entry.ID}
				if n == 0 {
					first = ids
				} else if !reflect.DeepEqual(first, ids) {
					t.Fatal(ids, first)
				}
				if name == "tiers" && ids[0] != "a" {
					t.Fatal(ids)
				}
				if (name == "bm25" || name == "fcfs") && ids[0] != "b" {
					t.Fatal(ids)
				}
				if s.BudgetOnly() != (name == "fcfs") {
					t.Fatal("budget policy")
				}
				for _, it := range items {
					if v := s.Value(it, 10); math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
						t.Fatal(v)
					}
				}
			}
		})
	}
	// Corpus document frequency, not candidate frequency: an unmatched document
	// still changes the plain baseline.
	other := scored("c", tierPrompt, "docs", "**", 10)
	other.item.Entry.Text = "compiler compiler compiler"
	before := bm25("compiler", snap).scores["b"]
	snap.Items = append(snap.Items, *other.item)
	if after := bm25("compiler", snap).scores["b"]; before == after {
		t.Fatal("ignored corpus")
	}
}
func TestRiskSignalsBoundedAndCurrent(t *testing.T) {
	a := scored("a", tierFile, "docs", "src/**", 30)
	a.item.Entry.When = []entries.Trigger{{Type: "anti", Match: "literal", Pattern: "oldCall("}}
	a.item.Entry.Checks = []entries.Check{{Kind: "pattern", Saw: map[string]any{"count": 9.0}}}
	b := a
	b.item = &entries.Item{Entry: &entries.Entry{ID: "b", When: a.item.Entry.When}}
	snap := &entries.Snapshot{Items: []entries.Item{*a.item, *b.item}}
	base := tiersScorer{}.Value(a, 30)
	for _, text := range []string{"", "oldCall("} {
		for _, verdict := range []string{held, changed} {
			a.verdict = verdict
			risk := newScorer("risk", text, snap, []shaped{a}, map[string]int{"a": 999})
			value := risk.Value(a, 30)
			if value < base || value > 3*base {
				t.Fatal(value, base)
			}
		}
	}
	snap.Items = snap.Items[:1]
	risk := newScorer("risk", "", snap, []shaped{a}, nil)
	if risk.Value(a, 30) != base {
		t.Fatal("stale pattern count used")
	}
	a.verdict = held
	if newScorer("risk", "", snap, []shaped{a}, nil).Value(a, 30) <= base {
		t.Fatal("current count ignored")
	}
}
func TestScorerSettingsPrecedenceAndBounds(t *testing.T) {
	env := Environment{Home: t.TempDir(), RecordDirectory: t.TempDir()}
	write := func(p string, v any) {
		t.Helper()
		os.MkdirAll(filepath.Dir(p), 0700)
		b, _ := json.Marshal(v)
		if err := os.WriteFile(p, b, 0600); err != nil {
			t.Fatal(err)
		}
	}
	global := filepath.Join(env.Home, "controls.json")
	project := filepath.Join(env.RecordDirectory, "hook-delivery", "p.json")
	if scorerSetting(env, "p") != "tiers" {
		t.Fatal("default")
	}
	write(global, map[string]any{"version": 1, "scorer": "bm25"})
	if scorerSetting(env, "p") != "bm25" {
		t.Fatal("global")
	}
	write(project, map[string]any{"version": 1, "scorer": "fcfs"})
	if scorerSetting(env, "p") != "fcfs" {
		t.Fatal("project")
	}
	env.Scorer = "risk"
	if scorerSetting(env, "p") != "risk" {
		t.Fatal("env")
	}
	env.Scorer = "invalid"
	if scorerSetting(env, "p") != "tiers" {
		t.Fatal("invalid override")
	}
	env.Scorer = ""
	os.WriteFile(project, make([]byte, 4097), 0600)
	if scorerSetting(env, "p") != "bm25" {
		t.Fatal("unbounded project file")
	}
	if scorerSetting(env, "../p") != "bm25" {
		t.Fatal("unsafe project")
	}
	os.Remove(project)
	if err := os.Link(global, project); err != nil {
		t.Fatal(err)
	}
	if b, err := readScorerFile(project); err == nil || b != nil {
		t.Fatal("followed hardlink")
	}
}
func TestAdmissionUsesChosenScorerAndSessionPressure(t *testing.T) {
	a := scored("a", tierCommand, "docs", "src/a.ts", 200)
	plan := []planned{{shaped: a, tokens: 200}}
	e := record.Epoch{Budget: 2000, TokensSent: 1000}
	c := record.DeliveryCandidate{EntryID: "a", Tokens: 200}
	tiers := admit(plan, tiersScorer{})
	fcfs := admit(plan, fcfsScorer{})
	if !fcfs(e, c) || tiers(e, c) {
		t.Fatal("FCFS used rising bar")
	}
	e.TokensSent = 0
	if !tiers(e, c) {
		t.Fatal("initial command")
	}
	e.SessionTokens = 6001
	if tiers(e, c) {
		t.Fatal("session ceiling did not raise bar")
	}
}
