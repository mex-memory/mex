package contract

import "testing"

func TestMark(t *testing.T) {
	if got := Mark("rule-3", "read cart.ts"); got != "[mex rule-3]\nread cart.ts" {
		t.Errorf("got %q", got)
	}
	if got := Mark("a b/c", "x"); got != "[mex a-b-c]\nx" {
		t.Errorf("unsafe id not cleaned: %q", got)
	}
	if got := Mark("", "x"); got != "[mex block]\nx" {
		t.Errorf("empty id: %q", got)
	}
}

func TestIsMarkedAndEnsure(t *testing.T) {
	if !IsMarked("[mex n1]\nbody") || !IsMarked("[mex n1]\r\nbody") {
		t.Error("marked text not recognized")
	}
	for _, s := range []string{"", "body", " [mex n1]\nx", "[mex]\nx", "[mex n 1]\nx"} {
		if IsMarked(s) {
			t.Errorf("%q should not count as marked", s)
		}
	}
	if got := EnsureMarked("note"); got != "[mex unmarked]\nnote" {
		t.Errorf("got %q", got)
	}
	if got := EnsureMarked("[mex a]\nnote"); got != "[mex a]\nnote" {
		t.Errorf("marked text changed: %q", got)
	}
	if EnsureMarked("") != "" {
		t.Error("empty context must stay empty")
	}
}

func TestStripMarked(t *testing.T) {
	cases := map[string]string{
		"fix the test": "fix the test",
		"fix the test\n[mex brief]\nproject notes\nmore": "fix the test",
		"[mex a]\none\n[mex b]\ntwo":                     "",
		"before\r\n[mex a]\r\nx":                         "before\r",
		"mention of [mex a] inline stays":                "mention of [mex a] inline stays",
	}
	for in, want := range cases {
		if got := StripMarked(in); got != want {
			t.Errorf("StripMarked(%q) = %q, want %q", in, got, want)
		}
	}
}
