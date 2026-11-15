package delivery

import (
	"path/filepath"
	"strings"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/record"
)

// ProbeResult is what the controller would send for one entry if its moment
// came now: "full", "pointer" or "withheld", with the text.
type ProbeResult struct {
	ID      string `json:"id"`
	Verdict string `json:"verdict"`
	Form    string `json:"form"`
	Text    string `json:"text,omitempty"`
}

// Probe runs the verdict stage of the real controller (the same verdict read,
// table and pointer or re-derivation code a moment uses) for the given
// entries, without touching the ledger. The knowledge bench gate uses it to
// see what reaches the model at each checkpoint. An entry the store doesn't
// have answers "withheld".
func Probe(env Environment, project, checkout string, ids []string) ([]ProbeResult, error) {
	snap, err := entries.Load(env.RecordDirectory, env.Home, project, checkout)
	if err != nil {
		return nil, err
	}
	byID := map[string]*entries.Item{}
	for i := range snap.Items {
		byID[snap.Items[i].Entry.ID] = &snap.Items[i]
	}
	h, err := record.OpenHooks(record.Location{Directory: env.RecordDirectory, Hooks: filepath.Join(env.RecordDirectory, "hooks.db")})
	if err != nil {
		return nil, err
	}
	defer h.Close()
	senv := &shapeEnv{recordDirectory: env.RecordDirectory, project: project, checkout: checkout, hooks: h}
	defer senv.close()
	out := make([]ProbeResult, 0, len(ids))
	for _, id := range ids {
		r := ProbeResult{ID: id, Verdict: unknown, Form: "withheld"}
		if v, ok, err := h.VerdictOf(project, checkout, id); err == nil && ok {
			r.Verdict = v.Verdict
		}
		if it := byID[id]; it != nil {
			s := shape(candidate{item: it, moment: "probe", tier: tierFile}, r.Verdict, senv)
			switch {
			case s.action == "withheld":
			case s.action == "replaced" && it.Entry.Kind == "fact":
				r.Form, r.Text = "pointer", strings.TrimSpace(s.full)
			default:
				r.Form, r.Text = "full", strings.TrimSpace(s.full)
			}
		}
		out = append(out, r)
	}
	return out, nil
}
