package entries

import (
	"strings"
	"sync"

	"github.com/mex-memory/mex/native/pattern"
)

// Literals holds one automaton over every literal `when:` pattern in a
// snapshot, so a read or an edit is scanned once for all entries rather
// than once per entry and pattern.
type Literals struct {
	scan *pattern.Literal
	ids  map[*Item]map[string][]int // per item and trigger type, its pattern indexes

	mu   sync.Mutex
	memo []scanned // the last few texts, so the same text is never scanned twice
}

type scanned struct {
	text  string
	found []bool
}

// literalMemo bounds the texts remembered; one event views few texts.
const literalMemo = 8

// Literals returns the snapshot's automaton, built on first use.
func (s *Snapshot) Literals() *Literals {
	if s.literals == nil {
		s.literals = newLiterals(s.Items)
	}
	return s.literals
}

func newLiterals(items []Item) *Literals {
	l := &Literals{ids: map[*Item]map[string][]int{}}
	var patterns []string
	index := map[string]int{}
	for i := range items {
		it := &items[i]
		if it.Entry == nil {
			continue
		}
		for _, w := range it.Entry.When {
			if w.Match != "literal" || strings.TrimSpace(w.Pattern) == "" {
				continue
			}
			id, ok := index[w.Pattern]
			if !ok {
				id = len(patterns)
				index[w.Pattern] = id
				patterns = append(patterns, w.Pattern)
			}
			if l.ids[it] == nil {
				l.ids[it] = map[string][]int{}
			}
			l.ids[it][w.Type] = append(l.ids[it][w.Type], id)
		}
	}
	l.scan = pattern.NewLiteral(patterns)
	return l
}

// Has reports whether text holds one of the item's literal patterns of the
// given trigger type ("anti", "rejected", ...).
func (l *Literals) Has(text string, it *Item, kind string) bool {
	ids := l.ids[it][kind]
	if len(ids) == 0 || text == "" {
		return false
	}
	return pattern.Any(l.found(text), ids)
}

func (l *Literals) found(text string) []bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	for _, m := range l.memo {
		if m.text == text {
			return m.found
		}
	}
	f := l.scan.Scan(text)
	if len(l.memo) == literalMemo {
		l.memo = l.memo[1:]
	}
	l.memo = append(l.memo, scanned{text, f})
	return f
}
