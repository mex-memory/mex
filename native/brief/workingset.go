package brief

import (
	"regexp"
	"sort"
	"strings"
	"unicode"

	"github.com/mex-memory/mex/native/check"
	"github.com/mex-memory/mex/native/delivery/entries"
	pathscope "github.com/mex-memory/mex/native/internal/scope"
	"github.com/mex-memory/mex/native/workset"
)

// Working-set selection constants. An entry's relevance adds up per link and is
// capped at 1: a scope naming a file in progress adds SeedWeight, one naming a
// file one hop away adds HopWeight, a directory scope counts half
// (ModuleFactor), and a branch-name word in its one-line adds WordWeight.
// Repo-wide scopes get GlobalRelevance. The score is
// relevance × confidence × (1 − StalenessDiscount × staleness), and nothing
// under Floor is sent.
const (
	SeedWeight        = 0.6
	HopWeight         = 0.3
	WordWeight        = 0.4
	ModuleFactor      = 0.5
	GlobalRelevance   = 0.5
	StalenessDiscount = 0.6
	Floor             = 0.20
	MaxItems          = 6
	MaxGlobal         = 2
	// The lane for knowledge nobody has accepted yet has its own budget, so it
	// can never displace accepted entries.
	LaneMaxItems  = 2
	LaneMaxTokens = 120
	LaneHeading   = "Not yet accepted:"
)

// scorer matches entry scopes against one working set. Globs compile once per
// brief; literal prefixes skip files that can't match.
type scorer struct {
	ws          *workset.Set
	seeds, hops map[string]bool
	words       []string
	compiled    map[string]*regexp.Regexp
}

func newScorer(ws *workset.Set) *scorer {
	s := &scorer{ws: ws, seeds: map[string]bool{}, hops: map[string]bool{}, compiled: map[string]*regexp.Regexp{}}
	for _, f := range ws.Seeds {
		s.seeds[f] = true
	}
	for _, f := range ws.Hops {
		if !s.seeds[f] {
			s.hops[f] = true
		}
	}
	s.words = ws.Words
	return s
}

// empty reports a set that names nothing, so the area selection stays in charge.
func (s *scorer) empty() bool { return len(s.seeds)+len(s.hops)+len(s.words) == 0 }

// repoWide reports a scope that governs the whole repo.
func repoWide(scope string) bool {
	return scope == "**" || scope == "**/*" || scope == "*" || scope == "./**"
}

// topLevel reports a directory scope one segment deep, such as src/**: it
// governs nearly everything, so linking it to a file in progress says nothing.
func topLevel(scope string) bool {
	if pathscope.Literal(scope) {
		return false
	}
	prefix := strings.Trim(pathscope.Prefix(scope), "/")
	return prefix == "" || !strings.Contains(prefix, "/")
}

func (s *scorer) matches(scope string, files map[string]bool) bool {
	if pathscope.Literal(scope) {
		return files[strings.TrimPrefix(scope, "./")]
	}
	re, ok := s.compiled[scope]
	if !ok {
		var err error
		if re, err = pathscope.CompileGlob(scope); err != nil {
			re = nil
		}
		s.compiled[scope] = re
	}
	if re == nil {
		return false
	}
	prefix := pathscope.Prefix(scope)
	for f := range files {
		if strings.HasPrefix(f, prefix) && re.MatchString(f) {
			return true
		}
	}
	return false
}

// relevance of one entry, and whether its only link is repo-wide.
// Repo-wide entries get a fixed base; MaxGlobal caps how many of them go.
func (s *scorer) relevance(e *entries.Entry) (float64, bool) {
	rel, isGlobal, linked := 0.0, false, false
	for _, scope := range e.Scope {
		if len(scope) > 512 || !safePath(scope) {
			continue
		}
		if repoWide(scope) {
			isGlobal = true
			continue
		}
		if topLevel(scope) {
			continue
		}
		factor := 1.0
		if !pathscope.Literal(scope) {
			factor = ModuleFactor
		}
		if s.matches(scope, s.seeds) {
			rel += SeedWeight * factor
			linked = true
		} else if s.matches(scope, s.hops) {
			rel += HopWeight * factor
			linked = true
		}
	}
	if s.hasWord(e.OneLine) {
		rel += WordWeight
		linked = true
	}
	if !linked && isGlobal {
		return GlobalRelevance, true
	}
	if rel > 1 {
		rel = 1
	}
	return rel, false
}

func (s *scorer) hasWord(text string) bool {
	if len(s.words) == 0 {
		return false
	}
	for _, w := range strings.FieldsFunc(strings.ToLower(text), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
		for _, word := range s.words {
			if w == word {
				return true
			}
		}
	}
	return false
}

// confidence follows the entry's evidence, strongest first; MEX has no
// per-entry confidence number, and evidence is what the brief already ranks by.
func confidence(e *entries.Entry, level string) float64 {
	if level == "hint" {
		return 0.6
	}
	switch strength(e) {
	case 0:
		return 1
	case 1:
		return 0.9
	case 2:
		return 0.85
	case 3:
		return 0.8
	}
	return 0.6
}

// staleness follows the verdict: a held check is fresh and a changed one is
// stale. An entry without a usable check is only a little discounted: nothing
// says it went stale, but nothing confirms it either. Broken entries never get
// here.
func staleness(verdict string) float64 {
	switch verdict {
	case check.Held:
		return 0
	case check.Changed:
		return 1
	}
	return 0.25
}

func score(rel float64, e *entries.Entry, level, verdict string) float64 {
	return rel * confidence(e, level) * (1 - StalenessDiscount*staleness(verdict))
}

// laneAllowed admits knowledge nobody has accepted yet: an observed hint the
// hint gate still allows, or an entry proposed but not in force.
func laneAllowed(e *entries.Entry, level, verdict string, hintAllowed func(string) bool) bool {
	if verdict == check.Broken || !validLine(e.OneLine) {
		return false
	}
	if e.Status == "proposed" {
		return true
	}
	return level == "hint" && e.Status == "active" && hintAllowed != nil && hintAllowed(e.ID)
}

type groupFunc func(c candidate, visiting, seen map[string]bool, area bool) ([]Item, bool)

// workingSelection picks the brief by the working set.
type workingSelection struct {
	sc          *scorer
	all         []candidate
	usable      func(candidate, bool) bool
	verdictOf   func(candidate) string
	addGroup    groupFunc
	itemFor     func(candidate, string) Item
	hintAllowed func(string) bool
}

type rankedCandidate struct {
	c      candidate
	score  float64
	global bool
}

func sortRanked(r []rankedCandidate) {
	sort.SliceStable(r, func(i, j int) bool {
		a, b := r[i], r[j]
		if a.score != b.score {
			return a.score > b.score
		}
		if (a.c.level == "personal") != (b.c.level == "personal") {
			return a.c.level == "personal"
		}
		if strength(a.c.entry) != strength(b.c.entry) {
			return strength(a.c.entry) < strength(b.c.entry)
		}
		return a.c.entry.ID < b.c.entry.ID
	})
}

// main fills the accepted lane: at most MaxItems lines within MaxTokens, at
// most MaxGlobal repo-wide team entries. A group that doesn't fit is skipped
// and the next one tried, so one long entry can't silence the rest.
func (w workingSelection) main(used int) []Item {
	var ranked []rankedCandidate
	for _, c := range w.all {
		if c.level == "hint" || c.entry.Status != "active" {
			continue
		}
		rel, isGlobal := w.sc.relevance(c.entry)
		// A scope only ranks the person's own notes: one scoped to a file
		// nobody touches yet still reaches the session, after the linked ones.
		if c.level == "personal" && rel < GlobalRelevance {
			rel = GlobalRelevance
		}
		if rel < Floor || !w.usable(c, false) {
			continue
		}
		verdict := w.verdictOf(c)
		if !allowed(c.entry, verdict, c.level) {
			continue
		}
		if s := score(rel, c.entry, c.level, verdict); s >= Floor {
			ranked = append(ranked, rankedCandidate{c, s, isGlobal})
		}
	}
	sortRanked(ranked)
	seen, lines := map[string]bool{}, map[string]bool{}
	var out []Item
	globals := 0
	// The person's notes don't count toward MaxItems; their budget is MaxNoteTokens.
	counted := func(items []Item) int {
		n := 0
		for _, item := range items {
			if item.Level != "personal" {
				n++
			}
		}
		return n
	}
	for _, r := range ranked {
		if seen[r.c.entry.ID] {
			continue
		}
		countsGlobal := r.global && r.c.level != "personal"
		if countsGlobal && globals >= MaxGlobal {
			continue
		}
		group, ok := w.addGroup(r.c, map[string]bool{}, seen, false)
		if !ok || len(group) == 0 {
			continue
		}
		cost := 0
		for _, item := range group {
			cost += item.Tokens
		}
		if used+cost > capFor(group) || (counted(group) > 0 && counted(out)+counted(group) > MaxItems) {
			continue
		}
		for _, item := range group {
			if lines[item.Line] {
				continue
			}
			out = append(out, item)
			seen[item.ID], lines[item.Line] = true, true
			used += item.Tokens
		}
		if countsGlobal {
			globals++
		}
	}
	return out
}

// lane fills the not-yet-accepted lane from observed hints and proposed
// entries, with its own budget. Its items travel alone, without companions.
func (w workingSelection) lane() []Item {
	var ranked []rankedCandidate
	for _, c := range w.all {
		if c.level != "hint" && c.entry.Status != "proposed" {
			continue
		}
		rel, isGlobal := w.sc.relevance(c.entry)
		if isGlobal || rel < Floor || !w.usable(c, false) {
			continue
		}
		verdict := w.verdictOf(c)
		if !laneAllowed(c.entry, c.level, verdict, w.hintAllowed) {
			continue
		}
		if s := score(rel, c.entry, c.level, verdict); s >= Floor {
			ranked = append(ranked, rankedCandidate{c, s, false})
		}
	}
	sortRanked(ranked)
	var out []Item
	used := TokenBound("\n" + LaneHeading)
	seen := map[string]bool{}
	for _, r := range ranked {
		if len(out) >= LaneMaxItems {
			break
		}
		if seen[r.c.entry.ID] {
			continue
		}
		item := w.itemFor(r.c, w.verdictOf(r.c))
		if used+item.Tokens > LaneMaxTokens {
			continue
		}
		out = append(out, item)
		seen[item.ID] = true
		used += item.Tokens
	}
	return out
}
