package delivery

import (
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/delivery/entries"
)

func TestLearnedShapingParity(t *testing.T) {
	for _, level := range []string{"personal", "team"} {
		for _, kind := range []string{"rule", "pitfall", "decision", "procedure"} {
			for _, tc := range []struct{ verdict, action string }{
				{held, "given"}, {broken, "withheld"}, {changed, "replaced"}, {unknown, "withheld"},
			} {
				t.Run(level+"/"+kind+"/"+tc.verdict, func(t *testing.T) {
					id := "mx_deep" + strings.Repeat("a", 32)
					c := candidate{item: &entries.Item{Level: level, Entry: &entries.Entry{
						ID: id, Kind: kind, Source: entries.Source{Type: "docs"},
					}, Full: "Use the checked loader.", OneLine: "Use the checked loader."}}
					got := shape(c, tc.verdict, nil)
					if got.action != tc.action {
						t.Fatalf("want %s: %+v", tc.action, got)
					}
					if tc.verdict == changed && got.full != "MEX is re-checking a learned rule: `mex recall "+id+"`" {
						t.Fatalf("changed: %q", got.full)
					}
					if tc.action == "withheld" && (got.full != "" || got.oneLine != "") {
						t.Fatalf("withheld entry still has text: %+v", got)
					}
				})
			}
		}
	}
}
