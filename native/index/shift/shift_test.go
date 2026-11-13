package shift

import (
	"reflect"
	"testing"
)

func TestShiftsMoveLinesBelowAChange(t *testing.T) {
	ranges := []Range{{From: 8, To: 8, Delta: 2}, {From: 21, To: 20, Delta: 1}}
	var got []int
	for _, line := range []int{1, 7, 8, 9, 20, 21, 22} {
		moved, ok := MapLine(line, ranges)
		if !ok {
			moved = -1
		}
		got = append(got, moved)
	}
	if want := []int{1, 7, -1, 11, 22, 24, 25}; !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	zero := 0
	outline := []Symbol{{Name: "A", Kind: "class", Start: 1, End: 20}, {Name: "a", Kind: "method", Start: 2, End: 5, Parent: &zero}, {Name: "f", Kind: "function", Start: 22, End: 30}}
	shifted, dropped, ok := Apply(outline, []Shift{{Ranges: []Range{{From: 1, To: 1}}}})
	if !ok || dropped != 1 || len(shifted) != 2 || shifted[0].Name != "a" || shifted[0].Parent != nil {
		t.Fatalf("drop and re-parent: %+v %d %v", shifted, dropped, ok)
	}
	if _, _, ok := Apply(outline, []Shift{{Unknown: true}}); ok {
		t.Fatal("unknown shift applied")
	}
}

func TestRangesFromStructuredPatch(t *testing.T) {
	response := `{"filePath":"/r/a.ts","structuredPatch":[{"oldStart":10,"oldLines":7,"newStart":10,"newLines":9,"lines":[
		" ctx 10"," ctx 11"," ctx 12","-old 13","+new 13a","+new 13b"," ctx 14","+added after 14"," ctx 15"]},
		{"oldStart":40,"oldLines":4,"newStart":43,"newLines":3,"lines":[" a"," b","-gone"," c","\\ No newline at end of file"]}]}`
	ranges, ok := RangesFromStructuredPatch(response, "other")
	want := []Range{{From: 13, To: 13, Delta: 1}, {From: 15, To: 14, Delta: 1}, {From: 42, To: 42, Delta: -1}}
	if !ok || !reflect.DeepEqual(ranges, want) {
		t.Fatalf("got %+v %v want %+v", ranges, ok, want)
	}
	if _, ok := RangesFromStructuredPatch(`{"filePath":"/r/a.ts","type":"create"}`, "ts"); ok {
		t.Fatal("a response without a patch was placed")
	}
}

func TestRangesFromHunks(t *testing.T) {
	after := "one\ntwo\nTHREE\nthree-b\nfour\nfive\nsix\nSEVEN\n"
	ranges, ok := RangesFromHunks(after, []Hunk{
		{Old: "two\nthree\nfour\n", New: "two\nTHREE\nthree-b\nfour\n"},
		{Old: "seven", New: "SEVEN"},
	}, "other")
	want := []Range{{From: 3, To: 3, Delta: 1}, {From: 7, To: 7, Delta: 0}}
	if !ok || !reflect.DeepEqual(ranges, want) {
		t.Fatalf("got %+v %v want %+v", ranges, ok, want)
	}
	for name, hunks := range map[string][]Hunk{
		"twice":   {{Old: "x", New: "o"}},
		"missing": {{Old: "x", New: "nowhere"}},
		"deleted": {{Old: "x\n", New: ""}},
	} {
		if _, ok := RangesFromHunks("o\no\n", hunks, "other"); ok {
			t.Errorf("%s: placed", name)
		}
	}
}

// The same cases as "changes that alter structure" in parse-and-glob.test.ts.
func TestChangesNesting(t *testing.T) {
	cases := []struct {
		lang           string
		removed, added []string
		want           bool
	}{
		{"ts", nil, []string{"  // note"}, false},
		{"ts", nil, []string{"  }", "", "  bar() {"}, true},
		{"ts", nil, []string{"  const x = 1;"}, false},
		{"ts", nil, []string{"  | 'feature'"}, true},
		{"ts", []string{"    return a +"}, []string{"    return b"}, true},
		{"ts", nil, []string{"@Injectable()"}, true},
		{"rs", nil, []string{"#[test]"}, true},
		{"cs", nil, []string{"    [Fact]"}, true},
		{"js", nil, []string{"  [1, 2].forEach(f)"}, false},
		{"ts", nil, []string{"  /**", "   * doc", "   */"}, false},
		{"ts", []string{"  if (a) {"}, []string{"  if (b) {"}, true},
		{"ts", []string{"  call(a)"}, []string{"  call(a, b)"}, false},
		{"py", nil, []string{"    x = 1"}, true},
		{"py", nil, []string{"    # comment", ""}, false},
	}
	for i, c := range cases {
		if got := changesNesting(c.lang, c.removed, c.added); got != c.want {
			t.Errorf("case %d (%s %q -> %q): got %v want %v", i, c.lang, c.removed, c.added, got, c.want)
		}
	}
}
