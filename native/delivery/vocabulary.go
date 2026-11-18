package delivery

import (
	"fmt"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/delivery/rank"
	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/internal/tokens"
	"github.com/mex-memory/mex/native/record"
)

// A team phrase in a typed prompt that exactly matches an entry's written
// alias earns one pointer line: the entry's verified code anchors, never its
// text. This does not use the ranker, so it is independent of delivery.aliases.
const (
	vocabularyLimit      = 2  // lines per prompt
	vocabularyScan       = 8  // matching entries examined per prompt
	vocabularyPaths      = 3  // paths or globs per line
	vocabularyIdentifier = 3  // identifiers per line
	vocabularyBodyScan   = 64 // identifier candidates read from one entry
)

// phraseKey lower-cases and collapses whitespace so a phrase matches across
// case and line breaks. Aliases are stored as the author wrote them.
func phraseKey(s string) string { return strings.Join(strings.Fields(strings.ToLower(s)), " ") }

// vocabularyAlias reports whether a written alias may trigger a pointer: at
// least two words, or at least six characters.
func vocabularyAlias(alias string) bool {
	key := phraseKey(alias)
	return len(strings.Fields(key)) >= 2 || utf8.RuneCountInString(key) >= 6
}

func phraseRune(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' }

// phraseIn finds a normalized phrase in normalized text at word boundaries.
func phraseIn(text, phrase string) bool {
	if phrase == "" {
		return false
	}
	for from := 0; from < len(text); {
		at := strings.Index(text[from:], phrase)
		if at < 0 {
			return false
		}
		start, end := from+at, from+at+len(phrase)
		before, _ := utf8.DecodeLastRuneInString(text[:start])
		after, _ := utf8.DecodeRuneInString(text[end:])
		if (start == 0 || !phraseRune(before)) && (end == len(text) || !phraseRune(after)) {
			return true
		}
		from = start + 1
	}
	return false
}

type vocabularyHit struct {
	item  *entries.Item
	alias string
}

// vocabularyHits returns each entry once, with its longest matching alias,
// longest phrase first. Entries that need the hint gate stay silent until it
// clears them, exactly as for every other prompt path.
func vocabularyHits(text string, snap *entries.Snapshot, gate func(*entries.Item) bool) []vocabularyHit {
	text = rank.PromptText(boundedText(text, anchorPromptBytes))
	if text == "" || rank.Machine(text) {
		return nil
	}
	key := phraseKey(text)
	var hits []vocabularyHit
	for i := range snap.Items {
		it := &snap.Items[i]
		if len(it.Entry.Aliases) == 0 || it.Entry.Status != "" && it.Entry.Status != "active" {
			continue
		}
		if it.NeedsHintGate && !gate(it) {
			continue
		}
		best := ""
		for _, alias := range it.Entry.Aliases {
			if vocabularyAlias(alias) && len(phraseKey(alias)) > len(phraseKey(best)) && phraseIn(key, phraseKey(alias)) {
				best = alias
			}
		}
		if best != "" {
			hits = append(hits, vocabularyHit{item: it, alias: strings.Join(strings.Fields(best), " ")})
		}
	}
	sort.SliceStable(hits, func(i, j int) bool {
		if a, b := len(phraseKey(hits[i].alias)), len(phraseKey(hits[j].alias)); a != b {
			return a > b
		}
		return hits[i].item.Entry.ID < hits[j].item.Entry.ID
	})
	return hits
}

// scopeAnchors lists the entry's scope entries the file index verifies: a
// literal file that is indexed and on disk, or a glob that matches at least
// one indexed file. Backslashes and a leading ./ are normalised.
func scopeAnchors(checkout string, e *entries.Entry, idx *index.Reader) (files, globs []string) {
	seen := map[string]bool{}
	for _, raw := range e.Scope {
		s := strings.TrimLeft(strings.ReplaceAll(raw, `\`, "/"), "/")
		for strings.HasPrefix(s, "./") {
			s = s[2:]
		}
		if s == "" || s == "**" || seen[s] || strings.Contains(s, "..") || strings.ContainsAny(s, "{}") {
			continue
		}
		seen[s] = true
		switch {
		case strings.HasSuffix(s, "/"):
			if m, _, err := idx.PathsMatching(s+"**", 1); err == nil && len(m) > 0 {
				globs = append(globs, s+"**")
			}
		case strings.ContainsAny(s, "*?["):
			if m, _, err := idx.PathsMatching(s, 1); err == nil && len(m) > 0 {
				globs = append(globs, s)
			}
		default:
			if idx.HasPath(s) && onDisk(checkout, s) {
				files = append(files, s)
			}
		}
	}
	return files, globs
}

// identifierAnchors names the entry's own identifiers that resolve to exactly
// one definition in the file index. The text is read only to find names.
func identifierAnchors(checkout, text string, idx *index.Reader) (names, locations, paths []string) {
	seen := map[string]bool{}
	for _, name := range anchorIDRE().FindAllString(text, vocabularyBodyScan*4) {
		if len(seen) >= vocabularyBodyScan || len(names) >= vocabularyIdentifier {
			break
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		separator := strings.Contains(name, "_")
		camel := strings.IndexAny(name[1:], "ABCDEFGHIJKLMNOPQRSTUVWXYZ") >= 0
		if !(separator || len(name) >= 6 && camel) {
			continue
		}
		if idx.DefinitionCount(name) != 1 {
			continue
		}
		hits, err := idx.SymbolsNamed(name)
		if err != nil || len(hits) != 1 || !onDisk(checkout, hits[0].Path) {
			continue
		}
		names = append(names, name)
		locations = append(locations, fmt.Sprintf("%s:%d", hits[0].Path, hits[0].Start))
		paths = append(paths, hits[0].Path)
	}
	return names, locations, paths
}

// vocabularyCards builds at most vocabularyLimit pointer lines. An entry with
// no verified anchor stays silent. The line never includes the entry text.
func vocabularyCards(ev contract.Event, env Environment, snap *entries.Snapshot, gate func(*entries.Item) bool) []answerCard {
	var out []answerCard
	for _, p := range vocabularyPointers(ev, env, snap, gate) {
		out = append(out, p.card)
	}
	return out
}

type vocabularyPointer struct {
	card          answerCard
	entry, phrase string
}

func vocabularyPointers(ev contract.Event, env Environment, snap *entries.Snapshot, gate func(*entries.Item) bool) []vocabularyPointer {
	if snap == nil || ev.Prompt == nil || !ev.Prompt.Typed || ev.Checkout == "" {
		return nil
	}
	hits := vocabularyHits(ev.Prompt.Text, snap, gate)
	if len(hits) == 0 {
		return nil
	}
	idx := openRescueIndex(env, ev)
	if idx == nil {
		return nil
	}
	defer closeRescueIndex(env, idx)
	var full *entries.Snapshot
	var out []vocabularyPointer
	for n, hit := range hits {
		if n >= vocabularyScan || len(out) >= vocabularyLimit {
			break
		}
		files, globs := scopeAnchors(ev.Checkout, hit.item.Entry, idx)
		body := hit.item.Entry.OneLine
		if hit.item.Entry.Text != "" {
			body += "\n" + hit.item.Entry.Text
		} else {
			// The light snapshot has no text. Load it once, only after a match.
			if full == nil {
				full = &entries.Snapshot{}
				if loaded, err := entries.Load(env.RecordDirectory, env.Home, ev.ProjectID, ev.Checkout); err == nil {
					full = &loaded
				}
			}
			for i := range full.Items {
				if full.Items[i].Entry.ID == hit.item.Entry.ID {
					body += "\n" + full.Items[i].Entry.Text
					break
				}
			}
		}
		names, locations, namePaths := identifierAnchors(ev.Checkout, body, idx)
		var parts, targetPaths []string
		for _, p := range files {
			if len(parts) < vocabularyPaths {
				parts = append(parts, p)
			}
			if !contains(targetPaths, p) {
				targetPaths = append(targetPaths, p)
			}
		}
		for _, g := range globs {
			if len(parts) < vocabularyPaths {
				parts = append(parts, g)
			}
		}
		if len(parts) == 0 && len(names) == 0 {
			continue
		}
		for _, p := range namePaths {
			if !contains(targetPaths, p) {
				targetPaths = append(targetPaths, p)
			}
		}
		text := fmt.Sprintf("%q in this repo:", hit.alias)
		if len(parts) > 0 {
			text += " " + strings.Join(parts, ", ")
		}
		if len(names) > 0 {
			var ids []string
			for i, name := range names {
				ids = append(ids, name+" ("+locations[i]+")")
			}
			text += "; " + strings.Join(ids, ", ")
		}
		if tokens.Code(text) > 120 {
			continue
		}
		if len(targetPaths) > 32 {
			targetPaths = targetPaths[:32]
		}
		target := record.SurfaceTarget{Paths: targetPaths}
		if len(globs) > 0 && len(globs) <= 32 {
			target.Scopes = globs
		}
		card := answerCard{surface: "prompt-anchor", text: text, id: "mex:vocabulary:" + contentHash(hit.item.Entry.ID + "\n" + text)[7:31], target: target}
		out = append(out, vocabularyPointer{card: card, entry: hit.item.Entry.ID, phrase: hit.alias})
	}
	return out
}

// VocabularyHit is one study result: which entry's phrase matched and the line
// that would be sent. The study never opens the record database.
type VocabularyHit struct {
	Entry  string `json:"entry"`
	Phrase string `json:"phrase"`
	Text   string `json:"text"`
}

// VocabularyStudy runs the pointer logic on explicit entries (with text) and
// returns what would be sent for each prompt.
func VocabularyStudy(ev contract.Event, env Environment, list []*entries.Entry) []VocabularyHit {
	snap := &entries.Snapshot{}
	for _, e := range list {
		snap.Items = append(snap.Items, entries.Item{Entry: e})
	}
	var indexes fileIndexCache
	env.fileIndexes = &indexes
	defer indexes.close()
	var out []VocabularyHit
	for _, p := range vocabularyPointers(ev, env, snap, func(*entries.Item) bool { return true }) {
		out = append(out, VocabularyHit{Entry: p.entry, Phrase: p.phrase, Text: p.card.text})
	}
	return out
}
