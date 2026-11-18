package rank

import (
	"errors"
	"math"
	"sort"

	"github.com/mex-memory/mex/native/internal/binenc"
)

// statsVersion 2 added the written-alias and ask fields.
const statsVersion = 2

// MarshalBinary persists statistics and exact-match metadata, never source
// prose. The bounded binary format avoids JSON reflection on each prompt.
func (ix *Index) MarshalBinary() ([]byte, error) {
	if ix.mode != DefaultMode || len(ix.fieldAvg) != fieldCount {
		return nil, errors.New("unsupported statistics mode")
	}
	var w binenc.Writer
	w.Uint(statsVersion)
	w.String(ix.mode)
	w.Uint(math.Float64bits(ix.avg))
	for _, avg := range ix.fieldAvg {
		w.Uint(math.Float64bits(avg))
	}
	writeTerms := func(terms map[string]int) {
		keys := make([]string, 0, len(terms))
		for key := range terms {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		w.Uint(uint64(len(keys)))
		for _, key := range keys {
			w.String(key)
			w.Uint(uint64(terms[key]))
		}
	}
	writeTerms(ix.df)
	w.Uint(uint64(len(ix.docs)))
	for _, d := range ix.docs {
		w.String(d.doc.ID)
		w.String(d.doc.Kind)
		w.Strings(d.doc.Scope)
		w.Strings(d.doc.Targets)
		w.Strings(d.doc.Literals)
		w.Uint(uint64(d.length))
		writeTerms(d.tf)
		for i, field := range d.fields {
			w.Uint(uint64(d.lengths[i]))
			writeTerms(field)
		}
	}
	return w.Bytes(), nil
}

func (ix *Index) UnmarshalBinary(b []byte) error {
	if len(b) > 32<<20 {
		return errors.New("rank statistics exceed bound")
	}
	r := binenc.NewReader(b)
	if r.Uint() != statsVersion || r.String() != DefaultMode {
		return errors.New("invalid rank statistics version")
	}
	c := Index{mode: DefaultMode, avg: math.Float64frombits(r.Uint())}
	validFloat := func(f float64) bool { return f >= 0 && !math.IsInf(f, 0) && !math.IsNaN(f) }
	if !validFloat(c.avg) {
		return errors.New("invalid average length")
	}
	for i := 0; i < fieldCount; i++ {
		avg := math.Float64frombits(r.Uint())
		if !validFloat(avg) {
			return errors.New("invalid field average")
		}
		c.fieldAvg = append(c.fieldAvg, avg)
	}
	work := 0
	readTerms := func() map[string]int {
		n := r.Count(100000)
		work += n
		if work > 2000000 {
			return nil
		}
		terms := make(map[string]int, n)
		for i := 0; i < n && r.Err() == nil; i++ {
			key := r.String()
			terms[key] = r.Count(1000000)
		}
		return terms
	}
	c.df = readTerms()
	n := r.Count(10000)
	for i := 0; i < n && r.Err() == nil && work <= 2000000; i++ {
		d := indexed{doc: Doc{ID: r.String(), Kind: r.String()}}
		d.doc.Scope, d.doc.Targets, d.doc.Literals = r.Strings(128), r.Strings(128), r.Strings(128)
		d.length = r.Count(1000000)
		d.tf = readTerms()
		for j := 0; j < fieldCount && work <= 2000000; j++ {
			d.lengths = append(d.lengths, r.Count(1000000))
			d.fields = append(d.fields, readTerms())
		}
		c.docs = append(c.docs, d)
	}
	if err := r.Done(); err != nil {
		return err
	}
	if work > 2000000 {
		return errors.New("rank term bound exceeded")
	}
	*ix = c
	return nil
}
