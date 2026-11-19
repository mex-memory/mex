package entries

import "testing"

func TestLiteralsHasByItemAndType(t *testing.T) {
	snap := &Snapshot{Items: []Item{
		{Entry: &Entry{ID: "mx_dates1", When: []Trigger{{Type: "anti", Match: "literal", Pattern: "from 'moment'"}}}},
		{Entry: &Entry{ID: "mx_reject", When: []Trigger{{Type: "rejected", Match: "literal", Pattern: "moment"}, {Type: "anti", Match: "structural", Pattern: "moment($$$)"}}}},
		{Entry: &Entry{ID: "mx_shared", When: []Trigger{{Type: "anti", Match: "literal", Pattern: "from 'moment'"}, {Type: "anti", Match: "literal", Pattern: "  "}}}},
		{Entry: nil},
	}}
	l := snap.Literals()
	text := "import m from 'moment'\n"
	dates, reject, shared := &snap.Items[0], &snap.Items[1], &snap.Items[2]
	switch {
	case !l.Has(text, dates, "anti"):
		t.Fatal("the anti literal is in the text")
	case l.Has(text, dates, "rejected"):
		t.Fatal("the entry has no rejected pattern")
	case !l.Has(text, reject, "rejected"):
		t.Fatal("rejected literal")
	case l.Has(text, reject, "anti"):
		t.Fatal("structural patterns are not literals")
	case !l.Has(text, shared, "anti"):
		t.Fatal("two entries share one pattern")
	case l.Has("", dates, "anti") || l.Has("import { format } from 'date-fns'", dates, "anti"):
		t.Fatal("no match")
	}
	if snap.Literals() != l {
		t.Fatal("built once per snapshot")
	}
	if len(l.memo) != 2 { // the empty text is never scanned
		t.Fatalf("each distinct text scanned once: %d", len(l.memo))
	}
	copied := *snap
	if copied.Literals() != l {
		t.Fatal("a copy shares the automaton")
	}
}
