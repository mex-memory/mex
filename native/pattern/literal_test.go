package pattern

import (
	"fmt"
	"math/rand"
	"strings"
	"testing"
)

func TestLiteralAgreesWithContains(t *testing.T) {
	r := rand.New(rand.NewSource(1))
	word := func(n int) string {
		b := make([]byte, 1+r.Intn(n))
		for i := range b {
			b[i] = "abc"[r.Intn(3)] // a small alphabet makes overlaps and shared prefixes common
		}
		return string(b)
	}
	for round := 0; round < 500; round++ {
		patterns := make([]string, 1+r.Intn(12))
		for i := range patterns {
			patterns[i] = word(5)
		}
		text := word(60)
		found := NewLiteral(patterns).Scan(text)
		for i, p := range patterns {
			if found[i] != strings.Contains(text, p) {
				t.Fatalf("round %d: %q in %q: got %v", round, p, text, found[i])
			}
		}
	}
}

func TestLiteralEdges(t *testing.T) {
	l := NewLiteral([]string{"from 'moment'", "", "from 'moment'", "console.log(", "moment"})
	found := l.Scan("import x from 'moment'\n")
	want := []bool{true, false, true, false, true}
	for i := range want {
		if found[i] != want[i] {
			t.Fatalf("pattern %d: got %v, want %v", i, found[i], want[i])
		}
	}
	if got := NewLiteral(nil).Scan("anything"); len(got) != 0 {
		t.Fatalf("no patterns: %v", got)
	}
	var none *Literal
	if none.Scan("x") != nil || none.Len() != 0 {
		t.Fatal("a nil automaton finds nothing")
	}
	if !Any(found, []int{3, 4}) || Any(found, []int{1, 3, 9, -1}) {
		t.Fatal("Any")
	}
	// Bytes, not runes: a pattern in UTF-8 matches inside UTF-8 text.
	if !NewLiteral([]string{"日本"}).Scan("こんにちは日本語")[0] {
		t.Fatal("UTF-8")
	}
}

// The scan cost stays flat as patterns grow: moves per byte are bounded by
// two (one step, plus failure moves paid for by earlier steps), whether the
// automaton holds one pattern or thousands.
func TestLiteralScanCostIsFlat(t *testing.T) {
	r := rand.New(rand.NewSource(2))
	text := make([]byte, 64<<10)
	for i := range text {
		text[i] = byte('a' + r.Intn(26))
	}
	for _, n := range []int{1, 10, 100, 1000, 5000} {
		patterns := make([]string, n)
		for i := range patterns {
			patterns[i] = fmt.Sprintf("zz%dq%sx", i, strings.Repeat("ab", i%7))
		}
		_, moves := NewLiteral(patterns).scan(string(text))
		if moves > 2*len(text) {
			t.Fatalf("%d patterns: %d moves over %d bytes", n, moves, len(text))
		}
	}
}

func BenchmarkLiteralScan(b *testing.B) {
	text := strings.Repeat("import { format } from 'date-fns';\nconst x = format(d, 'yyyy');\n", 1000)
	for _, n := range []int{1, 100, 1000} {
		patterns := make([]string, n)
		for i := range patterns {
			patterns[i] = fmt.Sprintf("from 'pkg-%d'", i)
		}
		l := NewLiteral(patterns)
		b.Run(fmt.Sprint(n), func(b *testing.B) {
			b.SetBytes(int64(len(text)))
			for i := 0; i < b.N; i++ {
				l.Scan(text)
			}
		})
	}
}
