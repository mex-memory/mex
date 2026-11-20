package hook

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"

	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/pattern"
)

// Bounds on the area a pattern check reads. Over them, the share is taken
// over the files read so far.
const (
	patternCheckFiles     = 5000
	patternCheckFileBytes = 512 << 10
	patternCheckBytes     = 64 << 20
	patternCheckMax       = 64 // candidates in one request
)

type patternCheckRequest struct {
	Checkout        string              `json:"checkout"`
	ProjectID       string              `json:"project_id"`
	RecordDirectory string              `json:"record_directory"`
	Scope           []string            `json:"scope"` // the entry's scope globs: the area
	Candidates      []pattern.Candidate `json:"candidates"`
}

// patternCheck answers `mex-hook --pattern-check`: the $0 self-check for
// patterns learned from a review, run in the background before an entry is
// written. The area's files are listed by the file index and read from the
// checkout; without an index the share is unknown and anti patterns are
// dropped.
func patternCheck(stdin io.Reader, stdout io.Writer) int {
	var req patternCheckRequest
	enc := json.NewEncoder(stdout)
	if err := json.NewDecoder(io.LimitReader(stdin, maxPayload)).Decode(&req); err != nil || req.Checkout == "" || len(req.Candidates) > patternCheckMax {
		_ = enc.Encode(checkFailure{Error: "invalid request"})
		return 2
	}
	area := readArea(req)
	results := make([]pattern.Verdict, len(req.Candidates))
	for i, c := range req.Candidates {
		results[i] = pattern.SelfCheck(c, area)
	}
	_ = enc.Encode(struct {
		OK      bool              `json:"ok"`
		Results []pattern.Verdict `json:"results"`
	}{true, results})
	return 0
}

// readArea reads the files the scope covers, or returns nil when the index
// can't say which files those are.
func readArea(req patternCheckRequest) pattern.Area {
	if req.RecordDirectory == "" || req.ProjectID == "" || len(req.Scope) == 0 {
		return nil
	}
	idx, err := index.Open(req.RecordDirectory, req.ProjectID, req.Checkout)
	if err != nil {
		return nil
	}
	defer idx.Close()
	seen := map[string]bool{}
	var paths []string
	for _, glob := range req.Scope {
		found, _, err := idx.PathsMatching(glob, patternCheckFiles)
		if err != nil {
			return nil // a glob the index can't list leaves the area unknown
		}
		for _, p := range found {
			if !seen[p] && len(paths) < patternCheckFiles {
				seen[p] = true
				paths = append(paths, p)
			}
		}
	}
	root, err := os.OpenRoot(req.Checkout)
	if err != nil {
		return nil
	}
	defer root.Close()
	area := pattern.Area{}
	total := 0
	for _, p := range paths {
		info, err := root.Stat(filepath.FromSlash(p))
		if err != nil || !info.Mode().IsRegular() || info.Size() > patternCheckFileBytes {
			continue
		}
		if total += int(info.Size()); total > patternCheckBytes {
			break
		}
		data, err := root.ReadFile(filepath.FromSlash(p))
		if err == nil {
			area = append(area, string(data))
		}
	}
	return area
}
