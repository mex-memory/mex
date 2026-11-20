package hook

import (
	"encoding/json"
	"errors"
	"io"

	"github.com/mex-memory/mex/native/graph"
	"github.com/mex-memory/mex/native/index"
)

// graphReadRequest is what `mex graph callers|callees|impact|tests` sends to
// `mex-hook --graph-read` on stdin.
type graphReadRequest struct {
	Op              string `json:"op"`
	Name            string `json:"name"`
	Checkout        string `json:"checkout"`
	ProjectID       string `json:"project_id"`
	RecordDirectory string `json:"record_directory"`
}

// graphRead answers one graph question with one JSON line. Like --check-run,
// it reports errors: a person is waiting for the answer.
func graphRead(stdin io.Reader, stdout io.Writer) int {
	enc := json.NewEncoder(stdout)
	var req graphReadRequest
	if err := json.NewDecoder(io.LimitReader(stdin, maxPayload)).Decode(&req); err != nil ||
		req.Checkout == "" || req.ProjectID == "" || req.RecordDirectory == "" || req.Name == "" {
		_ = enc.Encode(checkFailure{Error: "invalid request"})
		return 2
	}
	op := graph.Op(req.Op)
	switch op {
	case graph.OpCallers, graph.OpCallees, graph.OpImpact, graph.OpTests:
	default:
		_ = enc.Encode(checkFailure{Error: "unknown graph question"})
		return 2
	}

	var files graph.Files = graph.DiskFiles{Root: req.Checkout}
	isTest := func(string) bool { return false }
	if ix, err := index.Open(req.RecordDirectory, req.ProjectID, req.Checkout); err == nil {
		defer ix.Close()
		files = ix
		isTest = func(path string) bool {
			info, miss := ix.FileInfo(path)
			return miss == nil && info.IsTest
		}
	}
	store, err := graph.OpenStore(req.RecordDirectory, req.ProjectID, req.Checkout, isTest)
	if err != nil {
		if errors.Is(err, graph.ErrNoGraph) {
			_ = enc.Encode(checkFailure{Error: "no graph for this checkout"})
			return 3
		}
		_ = enc.Encode(checkFailure{Error: err.Error()})
		return 1
	}
	defer store.Close()

	answer, err := graph.Ask(store, files, op, req.Name)
	if err != nil {
		_ = enc.Encode(checkFailure{Error: err.Error()})
		return 1
	}
	_ = enc.Encode(struct {
		OK bool `json:"ok"`
		graph.Answer
	}{true, answer})
	return 0
}
