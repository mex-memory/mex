package delivery

import (
	"reflect"
	"testing"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/record"
)

func TestLearnedProcedureObservesAnEditInADifferentRole(t *testing.T) {
	item := &entries.Item{Entry: &entries.Entry{When: []entries.Trigger{
		{Type: "creates", Match: "literal", Pattern: "api/*.ts"},
		{Type: "creates", Match: "literal", Pattern: "sdk/*.ts"},
	}}}
	target := procedureReceiptTarget(planned{shaped: shaped{candidate: candidate{item: item, rel: "api/new.ts"}}})
	if !reflect.DeepEqual(target.Scopes, []string{"sdk/*.ts"}) {
		t.Fatalf("target: %+v", target)
	}
	if target.Origin != "learned-procedure:" {
		t.Fatalf("origin: %s", target.Origin)
	}
	for _, c := range []struct {
		path    string
		success bool
		acted   bool
	}{{"api/new.ts", true, false}, {"sdk/new.ts", false, false}, {"sdk/new.ts", true, true}} {
		if got := record.Acted("edit", target, record.SurfaceTool{Paths: []string{c.path}, Edit: true, Success: c.success}); got != c.acted {
			t.Fatalf("%+v: acted = %t", c, got)
		}
	}
}

func TestTwoProceduresDoNotClaimTheSameEdit(t *testing.T) {
	item := func(id, follow string) *entries.Item {
		return &entries.Item{Entry: &entries.Entry{ID: id, When: []entries.Trigger{
			{Type: "creates", Match: "literal", Pattern: "api/*.ts"},
			{Type: "creates", Match: "literal", Pattern: follow},
		}}}
	}
	first := procedureReceiptTarget(planned{shaped: shaped{candidate: candidate{item: item("mx_proc01", "sdk/*.ts"), rel: "api/new.ts"}}})
	second := procedureReceiptTarget(planned{shaped: shaped{candidate: candidate{item: item("mx_proc02", "sdk/*.ts"), rel: "api/new.ts"}}})
	tool := record.SurfaceTool{Paths: []string{"sdk/new.ts"}, Edit: true, Success: true}
	if !record.Acted("edit", first, tool) || !record.Acted("edit", second, tool) {
		t.Fatal("each procedure matches the edit on its own")
	}
	if !record.LearnedProcedureConflict([]record.SurfaceTarget{first, second}, tool) {
		t.Fatal("two procedures must not each record the edit")
	}
	if record.LearnedProcedureConflict([]record.SurfaceTarget{first}, tool) {
		t.Fatal("one procedure still records the edit")
	}
}
