package brief

import (
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/workset"
)

func ids(items []Item) []string {
	out := []string{}
	for _, item := range items {
		out = append(out, item.ID)
	}
	return out
}

func hint(id, line, scope string) string {
	return "---\nmex:\n  id: " + id + "\n  kind: pitfall\n  scope: [\"" + scope + "\"]\n  source: {type: observed, ref: session}\n  evidence: observed\n  one_line: \"" + line + "\"\n  status: active\n  created: 2026-11-15\n  checks: []\n---\n" + line + "\n"
}

func TestWorkingSetScoresFloorsCapsAndOrders(t *testing.T) {
	opts := setup(t)
	learned := func(id, line, scope string) {
		put(t, opts.Checkout, ".mex/learned/"+id+".md", entry(id, line, "rule", scope, "[]"))
	}
	learned("mx_seedfl", "Seed file rule.", "src/a.ts")
	learned("mx_module", "Module rule.", "src/lib/**")
	learned("mx_hopfle", "Hop file rule.", "src/b.ts")
	learned("mx_toplvl", "Top level rule.", "src/**")
	learned("mx_unrela", "Unrelated rule.", "src/zzz.ts")
	learned("mx_brword", "Payments retry rule.", "docs/x.md")
	learned("mx_global", "Global one.", "**")
	learned("mx_globa2", "Global two.", "**")
	learned("mx_globa3", "Global three.", "**")
	opts.WorkingSet = &workset.Set{Version: 1, Seeds: []string{"src/a.ts", "src/lib/x.ts"}, Hops: []string{"src/b.ts"}, Words: []string{"payments"}}
	r := build(t, opts)
	got := strings.Join(ids(r.Items), ",")
	// Seed file 0.6, globals 0.5 (two at most), branch word 0.4, then module
	// seed and hop file at 0.3, each × docs confidence × unchecked freshness.
	// The brief's byte bound stops it after four lines here.
	if got != "mx_seedfl,mx_globa2,mx_globa3,mx_brword" {
		t.Fatal(got)
	}
	opts.WorkingSet.Words = nil
	learned("mx_globa2", "Global two.", "docs/y.md")
	learned("mx_globa3", "Global three.", "docs/z.md")
	if got := strings.Join(ids(build(t, opts).Items), ","); got != "mx_seedfl,mx_global,mx_hopfle,mx_module" {
		t.Fatal(got)
	}
	for _, absent := range []string{"Top level rule", "Unrelated rule", "Global one"} {
		if strings.Contains(r.Text, absent) {
			t.Fatal(absent, r.Text)
		}
	}
	if len(r.Items) > MaxItems {
		t.Fatal(len(r.Items))
	}
	for _, item := range r.Previous {
		for _, chosen := range r.Items {
			if item.ID == chosen.ID {
				t.Fatal("previous repeats a chosen item", item.ID)
			}
		}
	}
	if a, b := build(t, opts), build(t, opts); a.Text != b.Text {
		t.Fatal("same inputs changed the brief")
	}
}

func TestWorkingSetSkipsWhatDoesNotFitAndKeepsGoing(t *testing.T) {
	opts := setup(t)
	put(t, opts.Checkout, ".mex/learned/mx_toolng.md", entry("mx_toolng", strings.Repeat("Long words here. ", 14), "rule", "src/a.ts", "[]"))
	put(t, opts.Checkout, ".mex/learned/mx_fitsok.md", entry("mx_fitsok", "Short one.", "rule", "src/lib/**", "[]"))
	opts.WorkingSet = &workset.Set{Version: 1, Seeds: []string{"src/a.ts", "src/lib/y.ts"}}
	r := build(t, opts)
	if got := strings.Join(ids(r.Items), ","); got != "mx_fitsok" {
		t.Fatal(got, r.Text)
	}
}

func TestWorkingSetFloorDropsWeakLinks(t *testing.T) {
	opts := setup(t)
	// A directory scope one hop away: 0.3 × 0.5 × confidence × freshness < 0.20.
	put(t, opts.Checkout, ".mex/learned/mx_weakhp.md", entry("mx_weakhp", "Weak hop.", "rule", "src/lib/**", "[]"))
	opts.WorkingSet = &workset.Set{Version: 1, Seeds: []string{"README.md"}, Hops: []string{"src/lib/z.ts"}}
	r := build(t, opts)
	if len(r.Items) != 0 {
		t.Fatal(r.Text)
	}
}

func TestWorkingSetPersonalNotesAreNotCappedAsGlobal(t *testing.T) {
	opts := setup(t)
	for _, id := range []string{"mx_mine01", "mx_mine02", "mx_mine03"} {
		put(t, opts.MexHome, "projects/"+project+"/notes/"+id+".md", entry(id, "Note "+id+".", "rule", "**", "[]"))
	}
	opts.WorkingSet = &workset.Set{Version: 1, Seeds: []string{"src/a.ts"}}
	r := build(t, opts)
	if len(r.Items) != 3 {
		t.Fatal(r.Text)
	}
}

func TestWorkingSetLaneHoldsOnlyAllowedHintsApart(t *testing.T) {
	opts := setup(t)
	put(t, opts.Checkout, ".mex/learned/mx_accept.md", entry("mx_accept", "Accepted rule.", "rule", "src/a.ts", "[]"))
	put(t, opts.MexHome, "projects/"+project+"/hints/mx_hint01.md", hint("mx_hint01", "Observed once.", "src/a.ts"))
	put(t, opts.MexHome, "projects/"+project+"/hints/mx_hint02.md", hint("mx_hint02", "Blocked hint.", "src/a.ts"))
	put(t, opts.MexHome, "projects/"+project+"/hints/mx_hint03.md", hint("mx_hint03", "Off the set.", "src/other.ts"))
	opts.WorkingSet = &workset.Set{Version: 1, Seeds: []string{"src/a.ts"}}
	opts.HintAllowed = func(id string) bool { return id != "mx_hint02" }
	r := build(t, opts)
	if got := strings.Join(ids(r.Items), ","); got != "mx_accept" {
		t.Fatal(got)
	}
	if got := strings.Join(ids(r.Lane), ","); got != "mx_hint01" {
		t.Fatal(got)
	}
	want := "[team, from docs] Accepted rule. (mx_accept)\n" + LaneHeading + "\n[hint, seen once] Observed once. (mx_hint01)"
	if !strings.HasSuffix(r.Text, want) {
		t.Fatal(r.Text)
	}
	opts.HintAllowed = nil
	if r := build(t, opts); len(r.Lane) != 0 {
		t.Fatal("hints without a gate", r.Text)
	}
}

func TestEmptyWorkingSetKeepsTheAreaSelection(t *testing.T) {
	opts := setup(t)
	opts.Path = "apps/api/handler.ts"
	put(t, opts.Checkout, ".mex/learned/mx_area01.md", entry("mx_area01", "Area rule.", "rule", "apps/api/**", "[]"))
	plain := build(t, opts)
	opts.WorkingSet = &workset.Set{Version: 1}
	withEmpty := build(t, opts)
	if plain.Text != withEmpty.Text || len(withEmpty.Previous) != 0 || !strings.Contains(plain.Text, "Area rule.") {
		t.Fatal(plain.Text, withEmpty.Text)
	}
}
