package hook

import (
	"encoding/json"
	"io"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/delivery/rank"
)

type rankQuery struct {
	ID     string    `json:"id"`
	Text   string    `json:"text"`
	Vector []float32 `json:"vector,omitempty"`
}
type recallRequest struct {
	Query   string               `json:"query"`
	Entries []*entries.Entry     `json:"entries"`
	Docs    []rank.Doc           `json:"docs"`
	Queries []rankQuery          `json:"queries"`
	Gates   []rank.Gate          `json:"gates"`
	Aliases map[string][]string  `json:"aliases"`
	Model   string               `json:"model"`
	Dims    int                  `json:"dims"`
	Vectors map[string][]float32 `json:"vectors"`
	Mode    string               `json:"mode"`
	Recall  bool                 `json:"recall"`
	// Aids indexes the entries' written aliases and asks.
	Aids bool `json:"aids"`
}
type recallRow struct {
	ID       string          `json:"id"`
	Ranked   []rank.Result   `json:"ranked"`
	Selected [][]rank.Result `json:"selected"`
	Vector   []float32       `json:"vector,omitempty"`
}

func recallRank(stdin io.Reader, stdout io.Writer) int {
	var req recallRequest
	enc := json.NewEncoder(stdout)
	fail := func(message string) int { _ = enc.Encode(map[string]any{"ok": false, "error": message}); return 0 }
	if json.NewDecoder(io.LimitReader(stdin, maxPayload)).Decode(&req) != nil || len(req.Entries)+len(req.Docs) > 10000 || len(req.Queries) > 512 || len(req.Gates) > 128 || len(req.Query) > 65536 {
		return fail("invalid ranking request")
	}
	docs := req.Docs
	for _, e := range req.Entries {
		if e == nil || len(e.Text) > 32768 || len(e.OneLine) > 4096 {
			return fail("invalid rank entry")
		}
		docs = append(docs, entries.RankDoc(e, req.Aids))
	}
	for i := range docs {
		if len(docs[i].Text) > 32768 || len(docs[i].Title) > 4096 || len(docs[i].Aliases) > 64 || len(docs[i].Written) > 64 || len(docs[i].Asks) > 64 {
			return fail("rank document exceeds bound")
		}
		if aliases := req.Aliases[docs[i].ID]; len(aliases) > 0 {
			if len(aliases) > 8 {
				return fail("alias bound")
			}
			for _, a := range aliases {
				if len(a) > 320 {
					return fail("alias bound")
				}
			}
			docs[i].Aliases = append(docs[i].Aliases, aliases...)
		}
	}
	ix := rank.BuildMode(docs, req.Mode)
	if len(req.Gates) == 0 {
		req.Gates = []rank.Gate{rank.DefaultGate()}
	}
	if len(req.Queries) == 0 {
		req.Queries = []rankQuery{{Text: req.Query}}
	}
	vectors := req.Vectors
	var model *rank.StaticModel
	if req.Model != "" {
		var err error
		model, err = rank.OpenStatic(req.Model, req.Dims)
		if err != nil {
			return fail(err.Error())
		}
		defer model.Close()
		if vectors == nil {
			vectors = map[string][]float32{}
			for _, d := range docs {
				v, err := model.Embed(rank.DenseText(d), req.Dims)
				if err != nil {
					return fail(err.Error())
				}
				vectors[d.ID] = v
			}
		}
	}
	var rows []recallRow
	for _, q := range req.Queries {
		if len(q.Text) > 65536 {
			return fail("query exceeds bound")
		}
		list := ix.Rank(q.Text)
		if !req.Recall && rank.Machine(q.Text) {
			list = nil
		}
		vector := q.Vector
		if model != nil {
			var err error
			vector, err = model.Embed(q.Text, req.Dims)
			if err != nil {
				return fail(err.Error())
			}
		}
		if len(vector) > 0 && len(vectors) > 0 {
			cos := map[string]float64{}
			for id, v := range vectors {
				cos[id] = rank.Dot(vector, v)
			}
			list = rank.Fuse(list, cos)
		}
		row := recallRow{ID: q.ID, Ranked: list[:min(20, len(list))], Vector: vector}
		for _, g := range req.Gates {
			if req.Recall {
				var selected []rank.Result
				for _, r := range list {
					if r.Score >= g.Floor || r.Exact {
						selected = append(selected, r)
					}
				}
				row.Selected = append(row.Selected, selected)
			} else {
				row.Selected = append(row.Selected, rank.Select(list, g))
			}
		}
		rows = append(rows, row)
	}
	_ = enc.Encode(map[string]any{"ok": true, "results": rows, "vectors": vectors, "docs": docs})
	return 0
}
