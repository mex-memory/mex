package rank

import (
	"encoding/json"
	"errors"
)

type cachedDoc struct {
	Doc     Doc
	TF      map[string]int
	Length  int
	Fields  []map[string]int
	Lengths []int
}
type cachedIndex struct {
	Version  int
	Docs     []cachedDoc
	DF       map[string]int
	Avg      float64
	Mode     string
	FieldAvg []float64
}

func (ix *Index) MarshalJSON() ([]byte, error) {
	c := cachedIndex{Version: statsVersion, DF: ix.df, Avg: ix.avg, Mode: ix.mode, FieldAvg: ix.fieldAvg}
	for _, r := range ix.docs {
		d := r.doc
		d.Title, d.Text, d.Aliases, d.Written, d.Asks = "", "", nil, nil, nil
		c.Docs = append(c.Docs, cachedDoc{d, r.tf, r.length, r.fields, r.lengths})
	}
	return json.Marshal(c)
}
func (ix *Index) UnmarshalJSON(b []byte) error {
	var c cachedIndex
	if err := json.Unmarshal(b, &c); err != nil {
		return err
	}
	if c.Version != statsVersion || c.Mode != DefaultMode || len(c.Docs) > 10000 || len(c.FieldAvg) != fieldCount || len(c.DF) > 100000 || c.Avg < 0 {
		return errors.New("invalid rank statistics")
	}
	*ix = Index{df: c.DF, avg: c.Avg, mode: c.Mode, fieldAvg: c.FieldAvg}
	for _, r := range c.Docs {
		if len(r.Fields) != fieldCount || len(r.Lengths) != fieldCount || r.Length < 0 || len(r.TF) > 100000 {
			return errors.New("invalid rank document")
		}
		ix.docs = append(ix.docs, indexed{r.Doc, r.TF, r.Length, r.Fields, r.Lengths})
	}
	return nil
}
