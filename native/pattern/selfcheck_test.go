package pattern

import (
	"strings"
	"testing"
)

func TestSelfCheck(t *testing.T) {
	objected := "import moment from 'moment'\nconst d = moment(x).format('YYYY')\n"
	fixed := "import { format } from 'date-fns'\nconst d = format(x, 'yyyy')\n"
	area := Area{
		"import { format } from 'date-fns'\n",
		"export const x = 1\n",
		"import moment from 'moment' // legacy, being removed\n",
		"console.log('hi')\n",
		"export function f() {}\n",
	}
	cases := []struct {
		name string
		c    Candidate
		area Area
		keep bool
	}{
		{"anti, objected only", Candidate{Type: "anti", Match: "literal", Pattern: "from 'moment'"}, area, true},
		{"anti, structural", Candidate{Type: "anti", Match: "structural", Pattern: "moment($X)"}, area, true},
		{"anti, not in the objected code", Candidate{Type: "anti", Match: "literal", Pattern: "require('moment')"}, area, false},
		{"anti, also in the fix", Candidate{Type: "anti", Match: "literal", Pattern: "const d ="}, area, false},
		{"anti, too common in the area", Candidate{Type: "anti", Match: "structural", Pattern: "import $X from $Y"}, append(Area{}, area[0], area[2], "import a from 'b'", "x"), false},
		{"anti, area unknown", Candidate{Type: "anti", Match: "literal", Pattern: "from 'moment'"}, nil, false},
		{"anti, empty area", Candidate{Type: "anti", Match: "literal", Pattern: "from 'moment'"}, Area{}, true},
		{"rejected", Candidate{Type: "rejected", Match: "literal", Pattern: "moment"}, area[:2], true},
		{"required, fix only", Candidate{Type: "required", Match: "literal", Pattern: "from 'date-fns'"}, nil, true},
		{"required, already there", Candidate{Type: "required", Match: "literal", Pattern: "const d"}, nil, false},
		{"creates", Candidate{Type: "creates", Match: "literal", Pattern: "migrations/*.sql"}, nil, true},
		{"bad structural", Candidate{Type: "anti", Match: "structural", Pattern: "moment("}, area, false},
		{"unknown type", Candidate{Type: "maybe", Match: "literal", Pattern: "x"}, area, false},
	}
	for _, c := range cases {
		c.c.Objected, c.c.Fixed = objected, fixed
		v := SelfCheck(c.c, c.area)
		if v.Keep != c.keep {
			t.Errorf("%s: keep %v (%s)", c.name, v.Keep, v.Reason)
		}
		if v.Reason == "" {
			t.Errorf("%s: no reason", c.name)
		}
	}
	// One other use in a three-file package is not the area's normal code.
	v := SelfCheck(Candidate{Type: "anti", Match: "literal", Pattern: "console.log(", Objected: "console.log(x)", Fixed: "log(x)"}, Area{"console.log(1)", "a", "b"})
	if !v.Keep || v.Files != 3 || v.Matched != 1 {
		t.Fatalf("share, small package: %+v", v)
	}
	big := Area{"console.log(1)", "console.log(2)", "console.log(3)"}
	for len(big) < 10 {
		big = append(big, "x")
	}
	v = SelfCheck(Candidate{Type: "anti", Match: "literal", Pattern: "console.log(", Objected: "console.log(x)", Fixed: "log(x)"}, big)
	if v.Keep || v.Matched != 3 || !strings.Contains(v.Reason, "3 of the area's 10 files") {
		t.Fatalf("share, common in the area: %+v", v)
	}
	for len(big) < 20 {
		big = append(big, "y")
	}
	if v = SelfCheck(Candidate{Type: "anti", Match: "literal", Pattern: "console.log(", Objected: "console.log(x)", Fixed: "log(x)"}, big); !v.Keep {
		t.Fatalf("share, 3 of 20 files is rare: %+v", v)
	}
}

// What a pattern names: a rule can't stand on keywords and short names, or
// on names the reviewed code declares for itself.
func TestSelfCheckNames(t *testing.T) {
	objected := "func trim(s string, n int) string {\n\tcommonDir := canonical(dir)\n\tfor i, r := range s {\n\t\tif strings.HasPrefix(s, commonDir) {\n\t\t\treturn s[i:]\n\t\t}\n\t}\n\tvar total = 0\n\tconst limit = 3\n\treturn moment.format(r)\n}\n"
	cases := []struct {
		pattern, match string
		keep           bool
	}{
		{"return s[i:]", "literal", false},                   // keywords and short names only
		{"string", "literal", false},                         // a built-in type
		{"commonDir", "literal", false},                      // a local variable
		{"total", "literal", false},                          // var
		{"limit", "literal", false},                          // const
		{"strings.HasPrefix(s, commonDir)", "literal", true}, // names an API
		{"strings.HasPrefix($A, $B)", "structural", true},    // metavariables don't count
		{"canonical(dir)", "literal", true},                  // a call, not a declaration
		{"func trim($$$) string", "structural", true},        // a function name stands
		{"moment.format($X)", "structural", true},            //
		{"The canonical form", "literal", false},             // not in the code at all
	}
	for _, c := range cases {
		v := SelfCheck(Candidate{Type: "anti", Match: c.match, Pattern: c.pattern, Objected: objected, Fixed: "x"}, Area{})
		if v.Keep != c.keep {
			t.Errorf("%q: keep %v (%s)", c.pattern, v.Keep, v.Reason)
		}
	}
	// JavaScript and Python declarations and parameters.
	js := "const { a, b: renamed } = props\nlet counter = 0\nitems.map((item, index) => item.id)\nfunction handle(event) { return event }\n"
	for _, name := range []string{"renamed", "counter", "index", "event"} {
		if v := SelfCheck(Candidate{Type: "anti", Match: "literal", Pattern: name, Objected: js, Fixed: "x"}, Area{}); v.Keep {
			t.Errorf("js %q kept", name)
		}
	}
	py := "def load(path, mode='r'):\n    result = open(path)\n    for line in result:\n        pass\n"
	for _, name := range []string{"path", "mode", "result", "line"} {
		if v := SelfCheck(Candidate{Type: "anti", Match: "literal", Pattern: name, Objected: py, Fixed: "x"}, Area{}); v.Keep {
			t.Errorf("python %q kept", name)
		}
	}
	if v := SelfCheck(Candidate{Type: "anti", Match: "literal", Pattern: "open(path)", Objected: py, Fixed: "x"}, Area{}); !v.Keep {
		t.Errorf("python open(path) dropped: %s", v.Reason)
	}
}

// The review comment's own lines: a pattern must touch them, unless the
// comment sits on a code comment, which may describe any of the block.
func TestSelfCheckAnchor(t *testing.T) {
	objected := "decls := lookupBase(node)\nif len(decls) > 0 && !isConstructor(container) {\n\tbreak\n}\n// Mirrors the reference: strip the prefix\nout := strings.TrimPrefix(name, base)\n"
	check := func(pattern, match, anchor string) bool {
		return SelfCheck(Candidate{Type: "anti", Match: match, Pattern: pattern, Objected: objected, Fixed: "x", Anchor: anchor}, Area{}).Keep
	}
	if !check("isConstructor($X)", "structural", "if len(decls) > 0 && !isConstructor(container) {") {
		t.Error("a pattern on the commented line was dropped")
	}
	if check("lookupBase(node)", "literal", "if len(decls) > 0 && !isConstructor(container) {") {
		t.Error("a pattern on another line was kept")
	}
	if !check("lookupBase(node)", "literal", "") {
		t.Error("no anchor: the line rule must not apply")
	}
	if !check("lookupBase(node)", "literal", "this line is not in the block at all") {
		t.Error("an anchor that isn't in the block must not apply")
	}
	if !check("strings.TrimPrefix", "literal", "\t// Mirrors the reference: strip the prefix") {
		t.Error("an anchor on a code comment must not pin a line")
	}
	// A structural match spanning several lines touches an anchor inside it.
	if !check("if len($D) > 0 && !isConstructor($C) { $$$ }", "structural", "\tbreak") {
		t.Error("a block pattern around the commented line was dropped")
	}
}

func TestStructuralSpans(t *testing.T) {
	code := "a := f(x)\n// f(y) in a comment\nb := f(\n  y\n)\n"
	spans := Spans("structural", "f($X)", code)
	if len(spans) != 2 {
		t.Fatalf("spans %v", spans)
	}
	if got := code[spans[0][0]:spans[0][1]]; got != "f(x)" {
		t.Errorf("first span %q", got)
	}
	if got := code[spans[1][0]:spans[1][1]]; got != "f(\n  y\n)" {
		t.Errorf("second span %q", got)
	}
	if lit := Spans("literal", "f(", code); len(lit) != 3 {
		t.Errorf("literal spans %v", lit)
	}
}
