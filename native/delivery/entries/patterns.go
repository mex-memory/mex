package entries

import (
	"strings"
	"sync"

	"github.com/mex-memory/mex/native/pattern"
)

// Patterns matches a snapshot's `when:` patterns. Literal ones share one
// automaton, so a read or an edit is scanned once for all entries rather
// than once per entry and pattern. Structural ones are compiled per entry
// on first use and run on edit hunks only.
type Patterns struct {
	scan       *pattern.Literal
	ids        map[*Item]map[string][]int // per item and trigger type, its pattern indexes
	structural map[*Item]map[string][]*pattern.Structural

	mu   sync.Mutex
	memo []scanned // the last few texts, so the same text is never scanned twice
}

type scanned struct {
	text  string
	found []bool
}

// literalMemo bounds the texts remembered; one event views few texts.
const literalMemo = 8

// Patterns returns the snapshot's matcher, built on first use.
func (s *Snapshot) Patterns() *Patterns {
	if s.patterns == nil {
		s.patterns = newPatterns(s.Items)
	}
	return s.patterns
}

func newPatterns(items []Item) *Patterns {
	l := &Patterns{ids: map[*Item]map[string][]int{}}
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
func (l *Patterns) Has(text string, it *Item, kind string) bool {
	ids := l.ids[it][kind]
	if len(ids) == 0 || text == "" {
		return false
	}
	return pattern.Any(l.found(text), ids)
}

func (l *Patterns) found(text string) []bool {
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

// editBytes bounds the added text structural patterns read in one edit.
const editBytes = 32 << 10

// InEdit reports whether an edit's added text holds one of the item's
// patterns of the given type, literal or structural. Pass only the text the
// edit adds (its hunks), never a whole file.
func (l *Patterns) InEdit(added string, it *Item, kind string) bool {
	if added == "" {
		return false
	}
	if l.Has(added, it, kind) {
		return true
	}
	if len(added) > editBytes {
		added = added[:editBytes]
	}
	for _, s := range l.structurals(it)[kind] {
		if s.Match(added) {
			return true
		}
	}
	return false
}

// structurals compiles an item's structural patterns once. A pattern that
// doesn't compile is skipped: it can never match, and the entry still
// works by path scope.
func (l *Patterns) structurals(it *Item) map[string][]*pattern.Structural {
	l.mu.Lock()
	defer l.mu.Unlock()
	if got, ok := l.structural[it]; ok {
		return got
	}
	var out map[string][]*pattern.Structural
	if it != nil && it.Entry != nil {
		for _, w := range it.Entry.When {
			if w.Match != "structural" {
				continue
			}
			if s, err := pattern.CompileStructural(w.Pattern); err == nil {
				if out == nil {
					out = map[string][]*pattern.Structural{}
				}
				out[w.Type] = append(out[w.Type], s)
			}
		}
	}
	if l.structural == nil {
		l.structural = map[*Item]map[string][]*pattern.Structural{}
	}
	l.structural[it] = out
	return out
}
