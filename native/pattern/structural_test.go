package pattern

import (
	"strings"
	"testing"
	"time"
)

func TestStructuralMatches(t *testing.T) {
	cases := []struct {
		pattern, code string
		want          bool
	}{
		{"console.log($$$)", "console.log(\n  'x', y)", true},
		{"console.log($$$)", "console .log ( /* why */ )", true},
		{"console.log($$$)", "logger.log('x')", false},
		{"console.log($$$)", "// console.log('x')\nlogger.info('x')", false},
		{"require('moment')", `const m = require("moment")`, true},
		{"require('moment')", `const m = require("moment-timezone")`, false},
		{"import $X from 'moment'", "import dayjs from 'moment'", true},
		{"import $X from 'moment'", "import { a, b } from 'moment'", true},
		{"$A.then($B)", "fetch(url).then(r => r.json())", true},
		{"$A == $A", "if (x == x) {}", true},
		{"$A == $A", "if (x == y) {}", false},
		{"new Date($$$)", "const d = new Date()", true},
		{"setTimeout($F, 0)", "setTimeout(() => go(), 0)", true},
		{"setTimeout($F, 0)", "setTimeout(() => go(), 10)", false},
		{"fmt.Println($$$)", "fmt.Println(\"a\", b)", true},
		{"db.Exec($Q, $$$ARGS)", "db.Exec(q, a, b)", true},
		{"eval($X)", "evaluate(x)", false},
		{"`select`", "'select'", true},
	}
	for _, c := range cases {
		s, err := CompileStructural(c.pattern)
		if err != nil {
			t.Fatalf("%q: %v", c.pattern, err)
		}
		if got := s.Match(c.code); got != c.want {
			t.Errorf("%q in %q: got %v, want %v", c.pattern, c.code, got, c.want)
		}
	}
}

func TestStructuralRejectsBadPatterns(t *testing.T) {
	for _, p := range []string{"", "   ", "// only a comment", "foo(", "a)", "[$X"} {
		if _, err := CompileStructural(p); err == nil {
			t.Errorf("%q compiled", p)
		}
	}
	var none *Structural
	if none.Match("x") {
		t.Fatal("a nil pattern matches nothing")
	}
}

func TestStructuralNeverHangs(t *testing.T) {
	s, err := CompileStructural("f($$$, $$$, $$$, $$$, x)")
	if err != nil {
		t.Fatal(err)
	}
	code := "f(" + strings.Repeat("a, ", 3000) + "y)"
	start := time.Now()
	if s.Match(code) {
		t.Fatal("no x in the call")
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("took %v; the step budget should stop it", d)
	}
}

func TestTokenizeUnterminated(t *testing.T) {
	for _, s := range []string{"'abc", "x = \"", "/* open", "`multi\nline", "'"} {
		_ = tokenize(s) // must not panic
	}
	if got := strings.Join(tokenize("a.b('c') // d\n/* e */ $F $$$ $$$G"), "|"); got != "a|.|b|(|'c'|)|$F|$$$|$$$G" {
		t.Fatalf("tokens: %s", got)
	}
}
