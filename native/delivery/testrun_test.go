package delivery

import (
	"math"
	"reflect"
	"testing"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/index/shift"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record"
)

// Spans follow later edits: an edit above moves them, and the edit's own
// lines join them.
func TestChangedLinesFollowEdits(t *testing.T) {
	c := ChangedLines{}
	c.Apply("a.ts", []shift.Range{{From: 10, To: 12, Delta: 0}}, true)
	if got := c["a.ts"]; !reflect.DeepEqual(got, []LineSpan{{10, 12}}) {
		t.Fatalf("first edit: %v", got)
	}
	// Three lines inserted at line 2 (an insertion has To = From-1).
	c.Apply("a.ts", []shift.Range{{From: 2, To: 1, Delta: 3}}, true)
	if got := c["a.ts"]; !reflect.DeepEqual(got, []LineSpan{{2, 4}, {13, 15}}) {
		t.Fatalf("after insert above: %v", got)
	}
	// A deletion marks where the lines were; adjacent spans merge.
	c.Apply("a.ts", []shift.Range{{From: 5, To: 8, Delta: -4}}, true)
	if got := c["a.ts"]; !reflect.DeepEqual(got, []LineSpan{{2, 5}, {9, 11}}) {
		t.Fatalf("after delete: %v", got)
	}
	// An edit that couldn't be placed marks the whole file.
	c.Apply("b.ts", nil, false)
	if got := c["b.ts"]; !reflect.DeepEqual(got, []LineSpan{{1, math.MaxInt32}}) {
		t.Fatalf("unplaced: %v", got)
	}
}

func TestChangedLinesBounds(t *testing.T) {
	c := ChangedLines{}
	for i := 0; i < maxChangedFiles+5; i++ {
		c.Apply(string(rune('a'+i%26))+string(rune('0'+i/26))+".ts", []shift.Range{{From: 1, To: 1}}, true)
	}
	if len(c) != maxChangedFiles {
		t.Fatalf("%d files kept", len(c))
	}
	d := ChangedLines{}
	for i := 0; i < maxChangedSpans+10; i++ {
		d.Apply("x.ts", []shift.Range{{From: 1 + i*3, To: 1 + i*3}}, true)
	}
	// Too scattered: folded into one span, never more than the bound.
	if got := d["x.ts"]; len(got) > maxChangedSpans || got[0].From != 1 || got[0].To < 3*maxChangedSpans {
		t.Fatalf("scattered spans: %v", got)
	}
}

func TestFullTestRun(t *testing.T) {
	cases := map[string]bool{
		"npm test":       true,
		"npx vitest run": true,
		"go test ./...":  true,
		"pytest -q":      true,
		"npx vitest run --config vitest.config.ts": true,
		"cd app && npm test":                       true,
		// A workspace package's whole suite: the package is not a file.
		"pnpm --filter @novu/providers run test 2>&1 | tail -30": true,
		"pnpm --filter=@acme/api test":                           true,
		"npm test -w @acme/core":                                 true,
		"yarn workspace @acme/web test":                          true,
		"pnpm --filter @acme/api test src/a.test.ts":             false,
		"npx vitest run src/a.test.ts":                           false,
		"go test ./internal/hook/":                               false,
		"go test -run TestX ./...":                               false,
		"pytest -k parse":                                        false,
		"npx jest -t 'routes work'":                              false,
		"npm run build":                                          false,
		"ls":                                                     false,
	}
	for command, want := range cases {
		ev := contract.Event{Kind: contract.PostTool, Tool: &contract.Tool{Name: contract.ToolShell, Input: contract.ToolInput{Command: command}, Output: &contract.ToolOutput{OK: true}}}
		if got := fullTestRun(ev); got != want {
			t.Errorf("%q: got %v, want %v", command, got, want)
		}
	}
	failed := contract.Event{Kind: contract.PostToolFailure, Tool: &contract.Tool{Name: contract.ToolShell, Input: contract.ToolInput{Command: "npm test"}, Output: &contract.ToolOutput{}}}
	if !fullTestRun(failed) {
		t.Error("a failing full run is a full run")
	}
	// Context added before a tool lands after its result, so the card waits
	// for the run's output: it is for the runs that follow.
	before := contract.Event{Kind: contract.PreTool, Tool: &contract.Tool{Name: contract.ToolShell, Input: contract.ToolInput{Command: "npm test"}}}
	if fullTestRun(before) {
		t.Error("a run that hasn't happened has no output to replace")
	}
}

// Without a project, a file index or a graph the tests card says nothing.
func TestTestRunCardsStaySilent(t *testing.T) {
	ev := contract.Event{Kind: contract.PostTool, ProjectID: "g-000000000000000000000000", Checkout: t.TempDir(),
		Tool: &contract.Tool{Name: contract.ToolShell, Input: contract.ToolInput{Command: "npm test"}, Output: &contract.ToolOutput{OK: true}}}
	env := Environment{RecordDirectory: t.TempDir(), Changed: ChangedLines{"x.ts": {{1, 3}}}}
	if cards := testRunCards(ev, env); len(cards) != 0 {
		t.Fatalf("%d cards without an index", len(cards))
	}
	ev.ProjectID = ""
	if cards := testRunCards(ev, env); len(cards) != 0 {
		t.Fatal("card without a project")
	}
}

func item(id, oneLine string, checks ...entries.Check) *entries.Item {
	return &entries.Item{Entry: &entries.Entry{ID: id, OneLine: oneLine, Checks: checks}}
}

func symbolCheck(file, symbol string) entries.Check {
	return entries.Check{Kind: "symbol", Target: map[string]any{"file": file, "symbol": symbol}}
}

func TestAboutSymbol(t *testing.T) {
	e := item("mx_aaaaaa", "x", symbolCheck("src/r.ts", "Router.parse")).Entry
	if !aboutSymbol(e, "src/r.ts", "parse") || !aboutSymbol(e, "src/r.ts", "Router.parse") {
		t.Fatal("same symbol not matched")
	}
	if aboutSymbol(e, "src/other.ts", "parse") || aboutSymbol(e, "src/r.ts", "par") || aboutSymbol(nil, "src/r.ts", "parse") {
		t.Fatal("matched a different symbol")
	}
}

// One card: the definition first, then at most two notes about it, within
// 600 characters; other entries are left to the usual rendering.
func TestMergedCards(t *testing.T) {
	card := answerCard{id: "mex:span:1", text: "src/r.ts:1-3\nfunction parse() {}", symPath: "src/r.ts", symName: "parse"}
	about := func(id, line string) planned {
		return planned{shaped: shaped{candidate: candidate{item: item(id, line, symbolCheck("src/r.ts", "parse"))}}}
	}
	plan := []planned{
		about("mx_note01", "parse strips the query string."),
		about("mx_note02", "parse is hot: keep it allocation-free."),
		about("mx_note03", "A third note about parse."),
		{shaped: shaped{candidate: candidate{item: item("mx_other1", "Unrelated.")}}},
	}
	var receipts []record.Receipt
	for _, id := range []string{"mex:span:1", "mx_note01", "mx_note02", "mx_note03", "mx_other1"} {
		receipts = append(receipts, record.Receipt{EntryID: id, Action: "given"})
	}
	text, folded := mergedCards([]answerCard{card}, plan, receipts)
	want := "src/r.ts:1-3\nfunction parse() {}\nNote: parse strips the query string. (mx_note01)\nNote: parse is hot: keep it allocation-free. (mx_note02)"
	if text != want {
		t.Fatalf("%s", text)
	}
	if !folded["mx_note01"] || !folded["mx_note02"] || folded["mx_note03"] || folded["mx_other1"] {
		t.Fatalf("folded %v", folded)
	}
	// A card that wasn't given carries nothing.
	if text, folded := mergedCards([]answerCard{card}, plan, receipts[1:]); text != "" || len(folded) != 0 {
		t.Fatalf("not given: %q %v", text, folded)
	}
}

func TestAttachSymbolCards(t *testing.T) {
	g := &group{checkout: "/repo", snap: &entries.Snapshot{}, cands: []candidate{{item: item("mx_note01", "x", symbolCheck("src/r.ts", "parse"))}}}
	about := answerCard{id: "a", symPath: "src/r.ts", symName: "parse"}
	other := answerCard{id: "b", symPath: "src/q.ts", symName: "query"}
	rest := attachSymbolCards([]*group{g}, "/repo", []answerCard{about, other})
	if len(g.cards) != 1 || g.cards[0].id != "a" || len(rest) != 1 || rest[0].id != "b" {
		t.Fatalf("attached %v, rest %v", g.cards, rest)
	}
	if left := withoutCards([]answerCard{about, other}, g.cards); len(left) != 1 || left[0].id != "b" {
		t.Fatalf("without: %v", left)
	}
}
