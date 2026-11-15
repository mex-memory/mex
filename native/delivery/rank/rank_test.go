package rank

import (
	"reflect"
	"strings"
	"testing"
)

func TestIdentifiersWeightsAndDeterminism(t *testing.T) {
	docs := []Doc{{ID: "a", Title: "Use shared connections", Text: "The connection pool stays alive.", Targets: []string{"src/db/pool.ts", "getPool"}}, {ID: "b", Title: "Build service", Text: "Compile the service."}}
	ix := Build(docs)
	first := ix.Rank("Where is `getPool()` in src/db/pool.ts?")
	if len(first) == 0 || first[0].ID != "a" || !first[0].Exact {
		t.Fatal(first)
	}
	for i := 0; i < 20; i++ {
		if !reflect.DeepEqual(first, ix.Rank("Where is `getPool()` in src/db/pool.ts?")) {
			t.Fatal("nondeterministic")
		}
	}
	if len(ix.Rank("astronomy dinosaurs")) != 0 {
		t.Fatal("irrelevant match")
	}
}
func TestGateCorroborationMarginAndSecond(t *testing.T) {
	rows := []Result{{ID: "a", Score: 1, Matched: []string{"one", "two", "three"}}, {ID: "b", Score: .9, Exact: true}, {ID: "c", Score: .2}, {ID: "d", Score: .1}}
	g := Gate{Floor: .4, Groups: 3, Margin: .4, Ratio: .8, Max: 2}
	if got := Select(rows, g); len(got) != 2 || got[0].ID != "a" || got[1].ID != "b" {
		t.Fatal(got)
	}
	rows[3].Score = .95
	if len(Select(rows, g)) != 0 {
		t.Fatal("weak margin")
	}
}
func TestLongWindowsAndMachineEnvelopes(t *testing.T) {
	ix := Build([]Doc{{ID: "a", Title: "Connection pool", Targets: []string{"getPool"}}})
	if r := ix.Rank(strings.Repeat("unrelated words ", 40) + " inspect `getPool()`"); len(r) != 1 || !r[0].Exact {
		t.Fatal(r)
	}
	for _, s := range []string{"<task-notification>finished</task-notification>", "```diff\n+foo\n```", "/expanded command", "Error: build failed\n at a.ts"} {
		if !Machine(s) {
			t.Fatal(s)
		}
	}
	if Machine("Please explain this error: `build failed`.") {
		t.Fatal("human request suppressed")
	}
}
func TestDenseDoesNotAdmitLexicalMiss(t *testing.T) {
	rows := Fuse([]Result{{ID: "a", Score: .1, Matched: []string{"one"}}}, map[string]float64{"a": 1, "b": 1})
	if len(Select(rows, DefaultGate())) != 0 {
		t.Fatal(rows)
	}
}
