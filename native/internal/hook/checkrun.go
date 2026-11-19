package hook

import (
	"encoding/json"
	"io"

	"github.com/mex-memory/mex/native/check"
	"github.com/mex-memory/mex/native/index"
	localrecord "github.com/mex-memory/mex/native/record"
)

// checkRequest is what `mex check` and MEX's writers send to
// `mex-hook --check-run` on stdin.
type checkRequest struct {
	Action          string `json:"action"` // "evaluate", "record" or "record-batch"
	Checkout        string `json:"checkout"`
	ProjectID       string `json:"project_id"`
	MexHome         string `json:"mex_home"`
	RecordDirectory string `json:"record_directory"`
	// Store writes the verdicts to hooks.db; off in CI and for --diff.
	Store    bool           `json:"store"`
	TeamOnly bool           `json:"team_only"`
	Kind     string         `json:"kind"`
	Role     string         `json:"role"`
	Target   map[string]any `json:"target"`
	// Items are the checks a record-batch writes, each against today's code.
	Items []recordItem       `json:"items"`
	Entry string             `json:"entry"`
	Files map[string]*string `json:"files"`
}

type recordItem struct {
	Kind   string         `json:"kind"`
	Role   string         `json:"role"`
	Target map[string]any `json:"target"`
}

// recordOutcome is one item's answer: its check, or why it couldn't be recorded.
type recordOutcome struct {
	OK    bool         `json:"ok"`
	Check *check.Check `json:"check,omitempty"`
	Error string       `json:"error,omitempty"`
}

// maxRecordItems bounds one batch; a writer with more sends several.
const maxRecordItems = 4096

type checkFailure struct {
	OK    bool   `json:"ok"`
	Error string `json:"error"`
}

// checkRun answers one request with one JSON line. Unlike a hook call it
// reports errors, because a person or a writer is waiting for the answer.
func checkRun(stdin io.Reader, stdout io.Writer) int {
	var req checkRequest
	enc := json.NewEncoder(stdout)
	if err := json.NewDecoder(io.LimitReader(stdin, maxPayload)).Decode(&req); err != nil || req.Checkout == "" {
		_ = enc.Encode(checkFailure{Error: "invalid request"})
		return 2
	}
	switch req.Action {
	case "evaluate-snapshot":
		e, err := check.ParseEntry([]byte(req.Entry))
		if err != nil {
			_ = enc.Encode(checkFailure{Error: "invalid snapshot entry"})
			return 2
		}
		ev, err := check.NewSnapshotEvaluator(req.Files)
		if err != nil {
			_ = enc.Encode(checkFailure{Error: err.Error()})
			return 2
		}
		defer ev.Close()
		_ = enc.Encode(struct {
			OK         bool         `json:"ok"`
			Result     check.Result `json:"result"`
			InputsHash string       `json:"inputs_hash"`
		}{true, ev.Evaluate(e), ev.SnapshotInputsHash(e, []byte(req.Entry))})
		return 0
	case "evaluate":
		opts := check.StageOptions{
			Checkout: req.Checkout, ProjectID: req.ProjectID, MexHome: req.MexHome,
			RecordDirectory: req.RecordDirectory, Force: true, TeamOnly: req.TeamOnly,
		}
		if req.Store && req.RecordDirectory != "" && req.ProjectID != "" {
			if hooks, err := localrecord.OpenHooks(hooksLocation(home{mex: req.MexHome}, req.RecordDirectory)); err == nil {
				defer hooks.Close()
				opts.Store = hooks
			}
		}
		report, err := check.RunStage(opts)
		if err != nil {
			_ = enc.Encode(checkFailure{Error: err.Error()})
			return 1
		}
		if opts.Store != nil {
			rebuildOnFlip(report, req.RecordDirectory, req.ProjectID, req.Checkout)
		}
		_ = enc.Encode(struct {
			OK     bool `json:"ok"`
			Stored bool `json:"stored"`
			check.StageReport
		}{true, opts.Store != nil, report})
		return 0
	case "record", "record-batch":
		if req.Action == "record-batch" && len(req.Items) > maxRecordItems {
			_ = enc.Encode(checkFailure{Error: "too many items"})
			return 2
		}
		ev, err := check.NewEvaluator(req.Checkout)
		if err != nil {
			_ = enc.Encode(checkFailure{Error: err.Error()})
			return 1
		}
		defer ev.Close()
		if req.RecordDirectory != "" && req.ProjectID != "" {
			if ix, err := index.Open(req.RecordDirectory, req.ProjectID, req.Checkout); err == nil {
				defer ix.Close()
				ev.UseIndex(ix)
			}
		}
		if req.Action == "record-batch" {
			// One process for many checks: files read once are cached by the evaluator.
			results := make([]recordOutcome, len(req.Items))
			for i, item := range req.Items {
				c, err := ev.Record(item.Kind, item.Role, item.Target)
				if err != nil {
					results[i] = recordOutcome{Error: err.Error()}
					continue
				}
				results[i] = recordOutcome{OK: true, Check: &c}
			}
			_ = enc.Encode(struct {
				OK      bool            `json:"ok"`
				Results []recordOutcome `json:"results"`
			}{true, results})
			return 0
		}
		c, err := ev.Record(req.Kind, req.Role, req.Target)
		if err != nil {
			_ = enc.Encode(checkFailure{Error: err.Error()})
			return 1
		}
		_ = enc.Encode(struct {
			OK    bool        `json:"ok"`
			Check check.Check `json:"check"`
		}{true, c})
		return 0
	}
	_ = enc.Encode(checkFailure{Error: "unknown action"})
	return 2
}
