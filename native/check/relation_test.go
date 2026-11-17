package check

import (
	"errors"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/index"
)

func boundary() map[string]any {
	return map[string]any{"query": "imports", "from": "src/core/**", "to": "src/adapters/**"}
}

// The demo rule: core never imports adapters. It holds until an import
// crosses the boundary, and the failure names the import.
func TestRelationBoundary(t *testing.T) {
	root := t.TempDir()
	ix := &fakeIndex{edges: []index.ImportEdge{
		{From: "src/core/run.ts", To: "src/core/util.ts"},
		{From: "src/adapters/http.ts", To: "src/core/run.ts"},
	}}
	c, err := indexed(t, root, ix).Record("relation", Complete, boundary())
	if err != nil {
		t.Fatal(err)
	}
	if c.Saw["count"] != 0 || len(c.Files) != 0 {
		t.Fatalf("recorded %+v", c)
	}
	if r := indexed(t, root, ix).Evaluate(&Entry{ID: "mx_rel001", Status: "active", Checks: []Check{c}}); r.Verdict != Held {
		t.Fatalf("held: %+v", r)
	}
	ix.edges = append(ix.edges, index.ImportEdge{From: "src/core/run.ts", To: "src/adapters/http.ts"}, index.ImportEdge{From: "src/core/util.ts", To: "src/adapters/db/index.ts"})
	r := indexed(t, root, ix).Evaluate(&Entry{ID: "mx_rel001", Status: "active", Checks: []Check{c}})
	if r.Verdict != Broken || r.Checks[0].Status != Fail || r.Checks[0].Now != 2 {
		t.Fatalf("crossed: %+v", r)
	}
	if want := "src/core/run.ts imports src/adapters/http.ts (2 imports in all)"; r.Checks[0].Reason != want {
		t.Fatalf("reason %q", r.Checks[0].Reason)
	}
}

// A file whose imports couldn't be read never lets the check say "none".
// Imports already found beyond the recorded count still fail: that's proof.
func TestRelationUnreadFiles(t *testing.T) {
	root := t.TempDir()
	c := Check{Kind: "relation", Role: Complete, Target: boundary(), Saw: map[string]any{"count": 0}, Files: map[string]string{}}
	ix := &fakeIndex{unread: map[string]int{"changed since the last parse": 1}}
	r := indexed(t, root, ix).Evaluate(&Entry{ID: "mx_rel002", Status: "active", Checks: []Check{c}})
	if r.Checks[0].Status != Floor || r.Verdict != Unknown || !strings.Contains(r.Checks[0].Reason, "1 file changed since the last parse") {
		t.Fatalf("unread: %+v", r)
	}
	if _, err := indexed(t, root, ix).Record("relation", Complete, boundary()); !errors.Is(err, ErrNotRecordable) {
		t.Fatalf("recorded over an unread file: %v", err)
	}
	ix.edges = []index.ImportEdge{{From: "src/core/run.ts", To: "src/adapters/http.ts"}}
	if r := indexed(t, root, ix).Evaluate(&Entry{ID: "mx_rel002", Status: "active", Checks: []Check{c}}); r.Verdict != Broken {
		t.Fatalf("proven despite unread: %+v", r)
	}
}

func TestRelationOtherQueriesWaitForTheGraph(t *testing.T) {
	root := t.TempDir()
	target := map[string]any{"query": "calls", "from": "src/core/**", "to": "src/adapters/**"}
	c := Check{Kind: "relation", Role: Complete, Target: target, Saw: map[string]any{"count": 0}, Files: map[string]string{}}
	r := indexed(t, root, &fakeIndex{}).Evaluate(&Entry{ID: "mx_rel003", Status: "active", Checks: []Check{c}})
	if r.Checks[0].Status != Floor || !strings.Contains(r.Checks[0].Reason, "need the code graph") {
		t.Fatalf("calls: %+v", r)
	}
	if r := verdict(t, root, Check{Kind: "relation", Role: Complete, Target: boundary(), Saw: map[string]any{"count": 0}}); r.Checks[0].Status != Floor {
		t.Fatalf("no index: %+v", r)
	}
}

func TestUnreadSummary(t *testing.T) {
	got := unreadSummary(map[string]int{"too big": 1, "imports not resolved for py": 3, "parse failed": 1})
	if want := "3 files imports not resolved for py, 1 file parse failed, 1 file too big"; got != want {
		t.Fatalf("%q", got)
	}
}
