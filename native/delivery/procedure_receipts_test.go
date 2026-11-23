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
