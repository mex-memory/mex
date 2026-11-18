package delivery

import (
	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/delivery/rank"
)

type PairStudy struct {
	A           string  `json:"a"`
	B           string  `json:"b"`
	Overlap     bool    `json:"overlap"`
	Shingles    bool    `json:"shingles"`
	Containment float64 `json:"containment"`
	Conflict    string  `json:"conflict"`
	Directive   bool    `json:"directive,omitempty"`
}

// StudyPairs measures the production predicates without opening storage.
func StudyPairs(docs []*entries.Entry) []PairStudy {
	var out []PairStudy
	for i, a := range docs {
		if a == nil {
			continue
		}
		for _, b := range docs[i+1:] {
			if b == nil {
				continue
			}
			x, y := shaped{candidate: candidate{item: &entries.Item{Entry: a}}}, shaped{candidate: candidate{item: &entries.Item{Entry: b}}}
			overlap := overlapping(x, y)
			if !overlap && a.Kind != b.Kind {
				continue
			}
			sx, sy := map[string]bool{}, map[string]bool{}
			for _, w := range rank.Tokens(a.OneLine + " " + a.Text) {
				sx[w] = true
			}
			for _, w := range rank.Tokens(b.OneLine + " " + b.Text) {
				sy[w] = true
			}
			n := 0
			for w := range sx {
				if sy[w] {
					n++
				}
			}
			ratio := float64(n) / float64(max(1, min(len(sx), len(sy))))
			out = append(out, PairStudy{
				A: a.ID, B: b.ID, Overlap: overlap, Shingles: shingleSimilar(a.OneLine, b.OneLine),
				Containment: ratio, Conflict: disagreement(x, y), Directive: directiveTrial(x, y),
			})
		}
	}
	return out
}
