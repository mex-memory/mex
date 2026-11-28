package delivery

import (
	"strings"
	"unicode/utf8"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/record"
)

// A card and an entry about the same symbol go out as one card: the card
// (the definition first), then up to two "Note:" lines from the entries, in
// at most 600 characters. Each item keeps its own receipt; only the text is
// joined. An entry that doesn't fit is sent as it would have been.

const (
	mergedNotes     = 2
	mergedCardChars = 600
)

// aboutSymbol reports an entry with a check on the symbol at path.
func aboutSymbol(e *entries.Entry, path, name string) bool {
	if e == nil || path == "" || name == "" {
		return false
	}
	for _, c := range e.Checks {
		file, _ := c.Target["file"].(string)
		symbol, _ := c.Target["symbol"].(string)
		if file == path && symbol != "" && (symbol == name || strings.HasSuffix(symbol, "."+name)) {
			return true
		}
	}
	return false
}

// attachSymbolCards moves each card about a symbol to the group holding an
// entry about that symbol, so both go out in one request. The cards left
// are sent on their own.
func attachSymbolCards(groups []*group, checkout string, cards []answerCard) []answerCard {
	var rest []answerCard
	for _, card := range cards {
		attached := false
		for _, g := range groups {
			if card.symName == "" || g.snap == nil || g.checkout != checkout {
				continue
			}
			for _, c := range g.cands {
				if aboutSymbol(c.item.Entry, card.symPath, card.symName) {
					g.cards = append(g.cards, card)
					attached = true
					break
				}
			}
			if attached {
				break
			}
		}
		if !attached {
			rest = append(rest, card)
		}
	}
	return rest
}

// mergedCards renders the given cards of a group, each followed by the notes
// of given entries about its symbol, and the ids folded in.
func mergedCards(cards []answerCard, plan []planned, receipts []record.Receipt) (string, map[string]bool) {
	given := map[string]bool{}
	for _, r := range receipts {
		if r.Action == "given" || r.Action == "replaced" {
			given[r.EntryID] = true
		}
	}
	folded := map[string]bool{}
	var blocks []string
	for _, card := range cards {
		if !given[card.id] {
			continue
		}
		text, notes := card.text, 0
		for _, p := range plan {
			id := p.item.Entry.ID
			if notes >= mergedNotes || p.correction || p.action == "replaced" || folded[id] || !given[id] || !aboutSymbol(p.item.Entry, card.symPath, card.symName) {
				continue
			}
			line := "Note: " + strings.TrimSpace(p.item.Entry.OneLine) + idSuffix(p.pointer, id)
			if utf8.RuneCountInString(text)+1+utf8.RuneCountInString(line) > mergedCardChars {
				continue
			}
			text += "\n" + line
			folded[id] = true
			notes++
		}
		blocks = append(blocks, text)
	}
	return strings.Join(blocks, "\n"), folded
}

// withoutCards drops the cards a group sent.
func withoutCards(cards, sent []answerCard) []answerCard {
	gone := map[string]bool{}
	for _, c := range sent {
		gone[c.id] = true
	}
	var out []answerCard
	for _, c := range cards {
		if !gone[c.id] {
			out = append(out, c)
		}
	}
	return out
}
