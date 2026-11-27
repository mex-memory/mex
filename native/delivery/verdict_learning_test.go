package delivery

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/record"
)

func TestLearnedShapingParity(t *testing.T) {
	for _, level := range []string{"personal", "team"} {
		for _, kind := range []string{"rule", "pitfall", "decision", "procedure"} {
			// Without a checkout to read, a cached hold can't be shown to be
			// current, so it is the pointer. TestLearnedHeldNeedsCurrentInputs
			// covers the hold that is given.
			for _, tc := range []struct{ verdict, action string }{
				{held, "replaced"}, {broken, "withheld"}, {changed, "replaced"}, {unknown, "withheld"},
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
					if got.action == "replaced" && got.full != "MEX is re-checking a learned rule: `mex recall "+id+"`" {
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

// A cached hold is given only while the inputs its checks read still support
// it. The cache is never refreshed here: the change happens on disk only.
func TestLearnedHeldNeedsCurrentInputs(t *testing.T) {
	for _, level := range []string{"personal", "team"} {
		for _, kind := range []string{"rule", "pitfall", "decision", "procedure"} {
			for _, tc := range []struct {
				name, action string
				change       func(f *fixture)
			}{
				{"unchanged", "given", func(*fixture) {}},
				{"unrelated file", "given", func(f *fixture) { f.file("README.md", "Edited elsewhere.") }},
				{"same value", "given", func(f *fixture) { f.file("policy.json", `{"active": true}`) }},
				{"value changed", "withheld", func(f *fixture) { f.file("policy.json", `{"active":false}`) }},
				{"input unreadable", "replaced", func(f *fixture) {
					if err := os.Remove(filepath.Join(f.root, "policy.json")); err != nil {
						t.Fatal(err)
					}
				}},
			} {
				t.Run(level+"/"+kind+"/"+tc.name, func(t *testing.T) {
					f := newFixture(t)
					id := "mx_deep" + strings.Repeat("b", 32)
					f.heldLearned(spec{id: id, kind: kind, level: level, scope: "src/**", source: "review", evidence: "review",
						producer: "learn-deeper", oneLine: "Use the checked loader."})
					tc.change(f)
					snap, err := entries.Load(f.dir, f.home, f.project, f.root)
					if err != nil {
						t.Fatal(err)
					}
					var it *entries.Item
					for i := range snap.Items {
						if snap.Items[i].Entry.ID == id {
							it = &snap.Items[i]
						}
					}
					if it == nil {
						t.Fatal("entry not loaded")
					}
					h, err := record.OpenHooks(record.Location{Directory: f.dir, Hooks: filepath.Join(f.dir, "hooks.db")})
					if err != nil {
						t.Fatal(err)
					}
					defer h.Close()
					senv := &shapeEnv{recordDirectory: f.dir, project: f.project, checkout: f.root, hooks: h}
					defer senv.close()
					got := shape(candidate{item: it, rel: "src/a.ts"}, held, senv)
					if got.action != tc.action {
						t.Fatalf("want %s: %+v", tc.action, got)
					}
					switch got.action {
					case "given":
						if !strings.Contains(got.full, "Use the checked loader.") {
							t.Fatalf("given without its text: %q", got.full)
						}
					case "replaced":
						if got.full != learnedPointer(id) || got.oneLine != got.full {
							t.Fatalf("replaced with more than the pointer: %+v", got)
						}
					default:
						if got.full != "" || got.oneLine != "" {
							t.Fatalf("withheld entry still has text: %+v", got)
						}
					}
				})
			}
		}
	}
}

// A broad scope whose named inputs are outside it, met by an edit that
// creates a new file, is proven by a path the index lists that is still on
// disk. With no such path the hold can't be shown current.
func TestLearnedHeldProvesBroadScopeOnDisk(t *testing.T) {
	for _, tc := range []struct {
		name, action string
		remove       bool
	}{
		{"indexed file on disk", "given", false},
		{"indexed file gone", "replaced", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := rescueFixture(t)
			f.file("src/a.ts", "export {}")
			plantIndex(t, f, map[string][]plantedSymbol{"src/a.ts": nil})
			id := "mx_deep" + strings.Repeat("c", 32)
			f.heldLearned(spec{id: id, kind: "rule", scope: "src/**", source: "review", evidence: "review",
				producer: "learn-deeper", oneLine: "Use the checked loader.", checks: []string{`    - kind: scope
      role: complete
      target: {glob: "src/**"}
      saw: {count: 1}
      files: {}
`}})
			if tc.remove {
				if err := os.Remove(filepath.Join(f.root, "src", "a.ts")); err != nil {
					t.Fatal(err)
				}
			}
			snap, err := entries.Load(f.dir, f.home, f.project, f.root)
			if err != nil {
				t.Fatal(err)
			}
			var it *entries.Item
			for i := range snap.Items {
				if snap.Items[i].Entry.ID == id {
					it = &snap.Items[i]
				}
			}
			if it == nil {
				t.Fatal("entry not loaded")
			}
			h, err := record.OpenHooks(record.Location{Directory: f.dir, Hooks: filepath.Join(f.dir, "hooks.db")})
			if err != nil {
				t.Fatal(err)
			}
			defer h.Close()
			senv := &shapeEnv{recordDirectory: f.dir, project: f.project, checkout: f.root, hooks: h}
			defer senv.close()
			if got := shape(candidate{item: it, rel: "src/new.ts"}, held, senv); got.action != tc.action {
				t.Fatalf("want %s: %+v", tc.action, got)
			}
		})
	}
}
