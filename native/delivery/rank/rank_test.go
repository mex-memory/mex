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

func TestWrittenAliasesAndAsksAreOwnFields(t *testing.T) {
	docs := []Doc{
		{ID: "mx_webhk1", Kind: "pitfall", Title: "Webhook retries use exponential backoff.", Text: "Providers rate-limit, so retries back off.", Asks: []string{"why do deliveries fail with too many requests"}, Written: []string{"429 storm"}},
		{ID: "mx_other1", Kind: "rule", Title: "Requests go through the API client.", Text: "The client adds auth headers to requests."},
		{ID: "mx_other2", Kind: "rule", Title: "Deliveries are logged.", Text: "Every delivery writes one log line."},
	}
	ix := Build(docs)
	for _, q := range []string{"deliveries fail with too many requests", "we hit a 429 storm"} {
		if got := ix.Rank(q); len(got) == 0 || got[0].ID != "mx_webhk1" {
			t.Fatalf("%q ranked %+v", q, got)
		}
	}
	// Without the aids the same entry has no match on the symptom words.
	plain := append([]Doc(nil), docs...)
	plain[0].Asks, plain[0].Written = nil, nil
	if got := Build(plain).Rank("we hit a 429 storm"); len(got) != 0 {
		t.Fatalf("aids leaked into other fields: %+v", got)
	}
	// Documents without aids score the same as before the fields existed.
	a, b := Build(plain[1:]).Rank("requests auth"), Build(docs[1:]).Rank("requests auth")
	if len(a) != len(b) || a[0].Score != b[0].Score {
		t.Fatal("empty aid fields changed scores")
	}
	bin, err := ix.MarshalBinary()
	if err != nil {
		t.Fatal(err)
	}
	var back Index
	if err := back.UnmarshalBinary(bin); err != nil {
		t.Fatal(err)
	}
	if got := back.Rank("we hit a 429 storm"); len(got) == 0 || got[0].ID != "mx_webhk1" {
		t.Fatal("aid statistics lost in the cache", got)
	}
}
