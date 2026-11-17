package delivery

import (
	"encoding/json"
	"io"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/internal/safefile"
)

// Scorer owns both ordering and admission. Construct it only after a moment
// finds candidates; no scorer does package initialization or opens storage.
type Scorer interface {
	Less(a, b shaped) bool
	Value(s shaped, tokens int) float64
	BudgetOnly() bool
}

func evidence(s shaped) int {
	if s.item.Level == "personal" && s.item.Entry.Source.Type == "person" {
		return 6
	}
	switch s.item.Entry.Evidence {
	case "person":
		return 6
	case "ci":
		return 5
	case "docs":
		return 4
	case "review":
		return 3
	case "mined":
		return 2
	default:
		return 1
	}
}

// Scope class dominates literal-prefix depth, which dominates token count.
// Entry scopes are at most 512 characters (at most 256 nonempty segments).
func specificity(s shaped) int {
	best := 0
	for _, scope := range s.item.Entry.Scope {
		class := 3
		at := strings.IndexAny(scope, "*?[]{}")
		prefix := scope
		if at >= 0 {
			prefix = scope[:at]
			class = 2
			if strings.HasSuffix(scope, "/**") && !strings.ContainsAny(strings.TrimSuffix(scope, "/**"), "*?[]{}") {
				class = 1
			}
			if scope == "**" || scope == "**/*" {
				class = 0
			}
		}
		depth := len(strings.FieldsFunc(strings.TrimSuffix(prefix, "/"), func(r rune) bool { return r == '/' }))
		if class == 0 {
			depth = 0
		}
		best = max(best, class*257+min(depth, 256))
	}
	return best
}

const patternBand = 2.4

type tiersScorer struct{}

func (tiersScorer) BudgetOnly() bool { return false }
func (tiersScorer) Less(a, b shaped) bool {
	if a.reserve != b.reserve {
		return a.reserve
	}
	if a.tier != b.tier {
		return a.tier < b.tier
	}
	if evidence(a) != evidence(b) {
		return evidence(a) > evidence(b)
	}
	if specificity(a) != specificity(b) {
		return specificity(a) > specificity(b)
	}
	if a.lineTok != b.lineTok {
		return a.lineTok < b.lineTok
	}
	return a.item.Entry.ID < b.item.Entry.ID
}
func (tiersScorer) Value(s shaped, tokens int) float64 {
	// Disjoint bands preserve trigger/evidence/scope order even across costs.
	// Cost only breaks ties within one scope. ID ties have equal admission value.
	base := 1.0 / 6000
	switch s.tier {
	case tierPattern:
		base = patternBand
	case tierCommand:
		base = 8.0 / 600
	case tierFile:
		base = .003
	case tierFolder:
		base = .0007
	}
	return base * (1 + .2*float64(evidence(s)-1) + .0001*float64(specificity(s)) + .000001/(1+float64(max(tokens, 1))/20))
}

type fcfsScorer struct{ order map[string]int }

func (fcfsScorer) BudgetOnly() bool { return true }
func (s fcfsScorer) Less(a, b shaped) bool {
	return s.order[a.item.Entry.ID] < s.order[b.item.Entry.ID]
}
func (fcfsScorer) Value(shaped, int) float64 { return 1 }

type bm25Scorer struct{ scores map[string]float64 }

func (bm25Scorer) BudgetOnly() bool { return false }
func (s bm25Scorer) Less(a, b shaped) bool {
	av, bv := s.scores[a.item.Entry.ID], s.scores[b.item.Entry.ID]
	if av != bv {
		return av > bv
	}
	return a.item.Entry.ID < b.item.Entry.ID
}
func (s bm25Scorer) Value(a shaped, tokens int) float64 {
	return 8 * s.scores[a.item.Entry.ID] / float64(max(1, tokens))
}

// Plain, unweighted BM25 baseline. All corpus work is bounded by the snapshot
// limits and 64 KiB of event text. This is distinct from the prompt gate.
func scoreWords(s string) []string {
	return strings.FieldsFunc(strings.ToLower(s), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) })
}
func bm25(query string, snap *entries.Snapshot) bm25Scorer {
	q := map[string]bool{}
	for _, w := range scoreWords(query) {
		q[w] = true
	}
	df := map[string]int{}
	docs := make([]map[string]int, len(snap.Items))
	lengths := make([]int, len(snap.Items))
	total := 0
	for i, it := range snap.Items {
		words := scoreWords(it.Entry.OneLine + " " + it.Entry.Text + " " + strings.Join(it.Entry.Scope, " "))
		lengths[i], total = len(words), total+len(words)
		docs[i] = map[string]int{}
		for _, w := range words {
			if q[w] {
				docs[i][w]++
			}
		}
		for w := range docs[i] {
			df[w]++
		}
	}
	out := bm25Scorer{map[string]float64{}}
	if len(snap.Items) == 0 || total == 0 {
		return out
	}
	avg := float64(total) / float64(len(snap.Items))
	// Sort query terms so float summation is byte deterministic.
	words := make([]string, 0, len(q))
	for w := range q {
		words = append(words, w)
	}
	sort.Strings(words)
	idfs, totalIDF := map[string]float64{}, 0.0
	for _, w := range words {
		idfs[w] = math.Log(1 + (float64(len(snap.Items)-df[w])+.5)/(float64(df[w])+.5))
		totalIDF += idfs[w]
	}
	for i, it := range snap.Items {
		score := 0.0
		matched := make([]string, 0, len(docs[i]))
		for w := range docs[i] {
			matched = append(matched, w)
		}
		sort.Strings(matched)
		for _, w := range matched {
			tf := float64(docs[i][w])
			if tf > 0 {
				score += idfs[w] * tf * 2.2 / (tf + 1.2*(.25+.75*float64(lengths[i])/avg))
			}
		}
		if totalIDF > 0 {
			out.scores[it.Entry.ID] = score / (2.2 * totalIDF)
		}
	}
	return out
}

type riskScorer struct {
	tiersScorer
	factors map[string]float64
}

func (s riskScorer) Value(a shaped, tokens int) float64 {
	factor := max(1, s.factors[a.item.Entry.ID])
	return s.tiersScorer.Value(a, tokens) * factor
}
func (s riskScorer) Less(a, b shaped) bool {
	if a.reserve != b.reserve {
		return a.reserve
	}
	av, bv := s.Value(a, a.lineTok), s.Value(b, b.lineTok)
	if av != bv {
		return av > bv
	}
	return s.tiersScorer.Less(a, b)
}

func newScorer(name, query string, snap *entries.Snapshot, items []shaped, missed map[string]int) Scorer {
	switch name {
	case "fcfs":
		order := map[string]int{}
		for i, it := range snap.Items {
			order[it.Entry.ID] = i
		}
		return fcfsScorer{order}
	case "bm25":
		return bm25(query, snap)
	case "risk":
		repeated := map[string]int{}
		for _, it := range snap.Items {
			seen := map[string]bool{}
			for _, w := range triggers(&it, "anti") {
				if !seen[w.Pattern] {
					repeated[w.Pattern]++
					seen[w.Pattern] = true
				}
			}
		}
		factors := map[string]float64{}
		for _, s := range items {
			factor := 1.0
			for _, w := range triggers(s.item, "anti") {
				if strings.Contains(query, w.Pattern) {
					factor = max(factor, 1.5)
				}
				if repeated[w.Pattern] > 1 {
					factor += .5
					break
				}
			}
			if s.verdict == held {
				for _, c := range s.item.Entry.Checks {
					count, _ := c.Saw["count"].(float64)
					if c.Kind == "pattern" && count > 0 {
						factor = max(factor, 1.5)
						break
					}
				}
			}
			if missed[s.item.Entry.ID] > 0 {
				factor += .5
			}
			factors[s.item.Entry.ID] = min(factor, 3)
		}
		return riskScorer{tiersScorer{}, factors}
	default:
		return tiersScorer{}
	}
}

// DefaultScorer orders the remaining non-exempt items. Deterministic first
// touches and exact fixes are lane rules, independent of lexical scores.
const DefaultScorer = "bm25"

func validScorer(s string) bool { return s == "tiers" || s == "bm25" || s == "fcfs" || s == "risk" }

// Existing Node settings are mirrored; these reads occur only for a delivery.
// The override is passed from the shim's environment seam, before any reads.
func scorerSetting(env Environment, project string) string {
	if env.Scorer != "" {
		if validScorer(env.Scorer) {
			return env.Scorer
		}
		return DefaultScorer
	}
	p := filepath.Join(env.RecordDirectory, "hook-delivery", project+".json")
	// A project identity must remain one path component, including in tests.
	if project != "" && !strings.ContainsAny(project, "/\\:") && project != ".." && project != "." {
		if projectValue := readPolicy(env, p); projectValue.Version == 1 && validScorer(projectValue.Scorer) {
			return projectValue.Scorer
		}
	}
	if global := readPolicy(env, filepath.Join(env.Home, "controls.json")); global.Version == 1 && validScorer(global.Scorer) {
		return global.Scorer
	}
	return DefaultScorer
}

// DefaultAids keeps written aliases and asks out of the prompt index until a
// measurement on prompts written blind to the entries shows they pay: at least
// +5 net (helped - 2*wrong) with no rise in wrong or false sends. The only
// measurement so far used aliases and prompts from the same model, and wrong
// sends rose by one, so the fields stay off by default.
const DefaultAids = false

// aidsSetting reads the override first, then the global delivery.aliases
// mirror in controls.json. It is read only for a typed prompt.
func aidsSetting(env Environment) bool {
	switch env.Aids {
	case "on", "1", "true":
		return true
	case "off", "0", "false":
		return false
	}
	var global struct {
		Version int
		Aliases string
	}
	if b, err := readScorerFile(filepath.Join(env.Home, "controls.json")); err == nil && json.Unmarshal(b, &global) == nil && global.Version == 1 {
		switch global.Aliases {
		case "on":
			return true
		case "off":
			return false
		}
	}
	return DefaultAids
}

func readScorerFile(p string) ([]byte, error) {
	if !safefile.Regular(p) {
		return nil, os.ErrInvalid
	}
	before, err := os.Lstat(p)
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() || before.Size() > 4096 {
		return nil, os.ErrInvalid
	}
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil || !os.SameFile(before, opened) {
		return nil, os.ErrInvalid
	}
	b, err := io.ReadAll(io.LimitReader(f, 4097))
	if err != nil {
		return nil, err
	}
	after, err := f.Stat()
	leaf, leafErr := os.Lstat(p)
	if err != nil || leafErr != nil || len(b) > 4096 || int64(len(b)) != opened.Size() || after.Size() != opened.Size() || !after.ModTime().Equal(opened.ModTime()) || !os.SameFile(opened, leaf) || !safefile.Regular(p) {
		return nil, os.ErrInvalid
	}
	return b, nil
}
