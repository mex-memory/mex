package rank

import (
	"math"
	"sort"
	"strings"
)

type Doc struct {
	ID      string   `json:"id"`
	Kind    string   `json:"kind,omitempty"`
	Title   string   `json:"title"`
	Text    string   `json:"text"`
	Aliases []string `json:"aliases,omitempty"`
	// Written aliases and asks come from the entry file, filtered at capture.
	// They are their own fields so they can be weighed and switched off apart
	// from the aliases derived from checks and literals.
	Written  []string `json:"written,omitempty"`
	Asks     []string `json:"asks,omitempty"`
	Targets  []string `json:"targets,omitempty"`
	Scope    []string `json:"scope,omitempty"`
	Literals []string `json:"literals,omitempty"`
}

type indexed struct {
	doc     Doc
	tf      map[string]int
	length  int
	fields  []map[string]int
	lengths []int
}
type Index struct {
	docs     []indexed
	df       map[string]int
	avg      float64
	mode     string
	drop     map[string]bool
	fieldAvg []float64
}

// BM25F fields, in order: title, derived aliases, text, scope, targets,
// written aliases, asks. Written aliases start at the derived aliases' weight
// and asks lower, because a whole question carries more common words.
var fieldWeights = []float64{3, 3, 1, 1, 1, 3, 2}

const fieldCount = 7

func Build(docs []Doc) *Index { return BuildMode(docs, DefaultMode) }
func BuildMode(docs []Doc, mode string) *Index {
	if mode == "" {
		mode = DefaultMode
	}
	ix := &Index{df: map[string]int{}, mode: mode, fieldAvg: make([]float64, fieldCount)}
	for _, d := range docs {
		written, asks := strings.Join(d.Written, " "), strings.Join(d.Asks, " ")
		fields := []string{d.Title, d.Title, d.Title, d.Text, strings.Join(d.Scope, " "), strings.Join(d.Targets, " "), strings.Join(d.Aliases, " "), strings.Join(d.Aliases, " "), strings.Join(d.Aliases, " "), written, written, written, asks, asks}
		terms := Tokens(strings.Join(fields, " "))
		r := indexed{doc: d, tf: map[string]int{}, length: len(terms)}
		if strings.HasPrefix(mode, "bm25f") {
			for j, field := range []string{d.Title, strings.Join(d.Aliases, " "), d.Text, strings.Join(d.Scope, " "), strings.Join(d.Targets, " "), written, asks} {
				ws := Tokens(field)
				tf := map[string]int{}
				for _, w := range ws {
					tf[w]++
				}
				r.fields = append(r.fields, tf)
				r.lengths = append(r.lengths, len(ws))
				ix.fieldAvg[j] += float64(len(ws))
			}
		}
		for _, w := range terms {
			r.tf[w]++
		}
		for w := range r.tf {
			ix.df[w]++
		}
		ix.docs = append(ix.docs, r)
		ix.avg += float64(r.length)
	}
	if mode == "bm25f-common" {
		ix.drop = map[string]bool{}
		for w, n := range ix.df {
			if float64(n) >= .6*float64(len(docs)) {
				ix.drop[w] = true
			}
		}
	}
	ix.avg /= float64(max(1, len(docs)))
	for i := range ix.fieldAvg {
		ix.fieldAvg[i] /= float64(max(1, len(docs)))
	}
	return ix
}

type Result struct {
	ID       string    `json:"id"`
	Score    float64   `json:"score"`
	Matched  []string  `json:"matched"`
	Exact    bool      `json:"exact"`
	Window   int       `json:"window"`
	Cosine   float64   `json:"cosine,omitempty"`
	Fused    float64   `json:"fused,omitempty"`
	Features []float64 `json:"features,omitempty"`
}

func (ix *Index) Rank(query string) []Result {
	queryLength, queryWindows := len(Tokens(query)), len(windows(query))
	question, task, pasted := 0.0, 0.0, 0.0
	lower := strings.ToLower(strings.TrimSpace(query))
	if strings.Contains(query, "?") || strings.HasPrefix(lower, "how ") || strings.HasPrefix(lower, "why ") || strings.HasPrefix(lower, "what ") {
		question = 1
	}
	for _, w := range []string{"add ", "fix ", "implement ", "build ", "remove ", "replace ", "update "} {
		if strings.HasPrefix(lower, w) {
			task = 1
		}
	}
	if Machine(query) {
		pasted = 1
	}
	best := map[string]Result{}
	for window, text := range windows(query) {
		seen := map[string]bool{}
		var words []string
		idf := map[string]float64{}
		sum := 0.0
		for _, w := range Tokens(text) {
			if !seen[w] && !ix.drop[w] {
				seen[w] = true
				words = append(words, w)
				idf[w] = math.Log(1 + (float64(len(ix.docs)-ix.df[w])+.5)/(float64(ix.df[w])+.5))
				sum += idf[w]
			}
		}
		ids := identifiers(text)
		for _, d := range ix.docs {
			r := Result{ID: d.doc.ID, Window: window}
			raw := 0.0
			mass, rare := 0.0, 0.0
			for _, w := range words {
				if n := d.tf[w]; n > 0 {
					tf := float64(n)
					lengthNorm := .25 + .75*float64(d.length)/math.Max(ix.avg, 1)
					if strings.HasPrefix(ix.mode, "bm25f") {
						tf = 0
						for j, weight := range fieldWeights {
							tf += weight * float64(d.fields[j][w]) / (.25 + .75*float64(d.lengths[j])/math.Max(ix.fieldAvg[j], 1))
						}
						lengthNorm = 1
					}
					raw += idf[w] * tf * 2.2 / (tf + 1.2*lengthNorm)
					r.Matched = append(r.Matched, w)
					mass += idf[w]
					rare = math.Max(rare, idf[w])
				}
			}
			boost := 1.0
			for _, id := range ids {
				for _, target := range append(append([]string{}, d.doc.Targets...), d.doc.Scope...) {
					t := strings.TrimSuffix(strings.ToLower(target), "()")
					if id == t || strings.HasSuffix(t, "/"+id) {
						r.Exact = true
						boost = 3
					}
				}
			}
			for _, literal := range d.doc.Literals {
				if len(literal) >= 3 && strings.Contains(strings.ToLower(text), strings.ToLower(literal)) {
					r.Exact = true
					boost = 3
				}
			}
			if raw <= 0 && !r.Exact {
				continue
			}
			if len(r.Matched) < 2 && !r.Exact {
				raw *= .6
			}
			r.Score = math.Max(raw, .01) * boost / math.Max(sum, 1)
			exact := 0.0
			if r.Exact {
				exact = 1
			}
			breadth := 0.0
			for _, sc := range d.doc.Scope {
				breadth = math.Max(breadth, float64(strings.Count(strings.Split(sc, "*")[0], "/")))
			}
			r.Features = []float64{1, r.Score, 0, 0, math.Log1p(float64(len(r.Matched))), mass / math.Max(sum, 1), rare, exact, math.Log1p(float64(queryLength)), float64(queryWindows), question, task, pasted, breadth}
			for _, kind := range []string{"rule", "pitfall", "recipe", "decision", "procedure", "fact", "hint"} {
				value := 0.0
				if d.doc.Kind == kind {
					value = 1
				}
				r.Features = append(r.Features, value)
			}
			old, ok := best[r.ID]
			if !ok || r.Score > old.Score {
				best[r.ID] = r
			}
		}
	}
	out := make([]Result, 0, len(best))
	for _, r := range best {
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Score != out[j].Score {
			return out[i].Score > out[j].Score
		}
		return out[i].ID < out[j].ID
	})
	for i := range out {
		second, fourth := 0.0, 0.0
		if len(out) > 1 {
			second = out[1].Score
		}
		if len(out) > 3 {
			fourth = out[3].Score
		}
		out[i].Features[2] = (out[i].Score - second) / math.Max(out[i].Score, .01)
		out[i].Features[3] = (out[i].Score - fourth) / math.Max(out[i].Score, .01)
		out[i].Features = append(out[i].Features, float64(i))
	}
	return out
}
func Select(list []Result, g Gate) []Result {
	if g.Learned {
		return learnedSelect(list)
	}
	var out []Result
	first := 0.0
	for _, r := range list[:min(12, len(list))] {
		if r.Score < g.Floor || (!r.Exact && len(r.Matched) < g.Groups) {
			continue
		}
		score := r.Score
		if r.Fused > 0 {
			if r.Cosine < g.Cosine {
				continue
			}
			score = r.Fused
		}
		if len(out) == 0 {
			fourth := 0.0
			if len(list) > 3 {
				fourth = list[3].Score
				if r.Fused > 0 {
					fourth = list[3].Fused
				}
			}
			if score-fourth < g.Margin*score {
				continue
			}
			first = score
		} else if score < g.Ratio*first {
			continue
		}
		out = append(out, r)
		if len(out) >= min(2, max(1, g.Max)) {
			break
		}
	}
	return out
}

// Fuse uses rank only; dense scores cannot admit an uncorroborated lexical miss.
func Fuse(list []Result, cosines map[string]float64) []Result {
	type hit struct {
		id  string
		cos float64
	}
	var dense []hit
	for id, c := range cosines {
		dense = append(dense, hit{id, c})
	}
	sort.Slice(dense, func(i, j int) bool {
		if dense[i].cos != dense[j].cos {
			return dense[i].cos > dense[j].cos
		}
		return dense[i].id < dense[j].id
	})
	positions := map[string]int{}
	for i, h := range dense[:min(20, len(dense))] {
		positions[h.id] = i + 1
	}
	out := append([]Result(nil), list...)
	for i := range out {
		r := &out[i]
		r.Cosine = cosines[r.ID]
		r.Fused = 61.0 / (60 + float64(i+1)) / 2
		if p := positions[r.ID]; p > 0 {
			r.Fused += 61.0 / (60 + float64(p)) / 2
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Fused != out[j].Fused {
			return out[i].Fused > out[j].Fused
		}
		return out[i].ID < out[j].ID
	})
	return out
}
