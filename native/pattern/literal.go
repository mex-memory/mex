// Package pattern matches an entry's `when:` code patterns.
//
// Literal patterns run as one automaton over the whole text (plan sheet 31):
// the scan reads each byte once, whatever the number of patterns, so adding
// entries never makes a read or an edit slower to check.
package pattern

import "sort"

// Literal finds which of a fixed set of literal patterns occur in a text.
// Build it once per snapshot; it is safe to share between goroutines.
type Literal struct {
	root  [256]int32 // transitions out of the root, dense: most bytes stop here
	edges [][]edge   // transitions out of every other state, sorted by byte
	fail  []int32
	out   []int32 // the pattern ending at this state, or -1
	dict  []int32    // the nearest state on the failure chain with an output, or -1
	alias [][2]int32 // a duplicate pattern's index and the index it shares a state with
	n     int
}

// Len is the number of patterns the automaton was built from.
func (l *Literal) Len() int {
	if l == nil {
		return 0
	}
	return l.n
}

// Scan reports which patterns occur in text: found[i] is true when
// patterns[i] does. One pass, one step per byte plus failure moves, which
// are paid for by earlier steps; the number of patterns never adds a pass.
func (l *Literal) Scan(text string) (found []bool) {
	found, _ = l.scan(text)
	return found
}

func (l *Literal) scan(text string) (found []bool, moves int) {
	if l == nil {
		return nil, 0
	}
	found = make([]bool, l.n)
	left := 0 // distinct patterns, so a text holding all of them can stop early
	for _, o := range l.out {
		if o >= 0 {
			left++
		}
	}
	s := int32(0)
	for i := 0; i < len(text) && left > 0; i++ {
		b := text[i]
		for {
			moves++
			if to, ok := l.step(s, b); ok {
				s = to
				break
			}
			if s == 0 {
				break
			}
			s = l.fail[s]
		}
		for o := s; o > 0; o = l.dict[o] {
			if p := l.out[o]; p >= 0 && !found[p] {
				found[p] = true
				left--
			} else if p >= 0 {
				break // this state and its whole chain were reported before
			}
			if l.dict[o] < 0 {
				break
			}
		}
	}
	for _, a := range l.alias {
		found[a[0]] = found[a[1]]
	}
	return found, moves
}

// Any reports whether text holds at least one of the patterns whose
// indexes are given.
func Any(found []bool, indexes []int) bool {
	for _, i := range indexes {
		if i >= 0 && i < len(found) && found[i] {
			return true
		}
	}
	return false
}

type edge struct {
	b  byte
	to int32
}

// NewLiteral builds the automaton. Empty patterns never match. Duplicates
// share a state; Scan reports every index that names a found pattern.
func NewLiteral(patterns []string) *Literal {
	l := &Literal{edges: [][]edge{nil}, fail: []int32{0}, out: []int32{-1}, dict: []int32{-1}, n: len(patterns)}
	var alias [][2]int32 // [duplicate, first] pairs, resolved after the scan
	for i, p := range patterns {
		if p == "" {
			continue
		}
		s := int32(0)
		for j := 0; j < len(p); j++ {
			next, ok := l.step(s, p[j])
			if !ok {
				next = int32(len(l.edges))
				l.edges = append(l.edges, nil)
				l.fail = append(l.fail, 0)
				l.out = append(l.out, -1)
				l.dict = append(l.dict, -1)
				l.add(s, p[j], next)
			}
			s = next
		}
		if l.out[s] >= 0 {
			alias = append(alias, [2]int32{int32(i), l.out[s]})
		} else {
			l.out[s] = int32(i)
		}
	}
	l.link()
	l.alias = alias
	return l
}

func (l *Literal) add(s int32, b byte, to int32) {
	if s == 0 {
		l.root[b] = to
		return
	}
	es := l.edges[s]
	i := sort.Search(len(es), func(i int) bool { return es[i].b >= b })
	es = append(es, edge{})
	copy(es[i+1:], es[i:])
	es[i] = edge{b, to}
	l.edges[s] = es
}

// step follows the goto edge only (no failure links).
func (l *Literal) step(s int32, b byte) (int32, bool) {
	if s == 0 {
		to := l.root[b]
		return to, to != 0
	}
	es := l.edges[s]
	lo, hi := 0, len(es)
	for lo < hi {
		m := (lo + hi) / 2
		switch {
		case es[m].b == b:
			return es[m].to, true
		case es[m].b < b:
			lo = m + 1
		default:
			hi = m
		}
	}
	return 0, false
}

// link sets the failure and output links breadth first.
func (l *Literal) link() {
	queue := make([]int32, 0, len(l.edges))
	for b := 0; b < 256; b++ {
		if to := l.root[b]; to != 0 {
			queue = append(queue, to)
		}
	}
	for len(queue) > 0 {
		s := queue[0]
		queue = queue[1:]
		for _, e := range l.edges[s] {
			f := l.fail[s]
			for {
				if to, ok := l.step(f, e.b); ok {
					l.fail[e.to] = to
					break
				}
				if f == 0 {
					break
				}
				f = l.fail[f]
			}
			if g := l.fail[e.to]; l.out[g] >= 0 {
				l.dict[e.to] = g
			} else {
				l.dict[e.to] = l.dict[g]
			}
			queue = append(queue, e.to)
		}
	}
}
