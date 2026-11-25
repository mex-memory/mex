package hook

import (
	"encoding/json"
	"io"
	"path/filepath"

	"github.com/mex-memory/mex/native/capture"
)

// Invoked by the background learning job. This command only observes Git.
func sessionLifetimes(stdin io.Reader, stdout io.Writer) int {
	var request struct {
		Checkout string               `json:"checkout"`
		Branches []capture.NoteBranch `json:"branches"`
		Tags     bool                 `json:"tags"`
	}
	in := json.NewDecoder(io.LimitReader(stdin, 256<<10))
	in.DisallowUnknownFields()
	if in.Decode(&request) != nil || len(request.Checkout) > 4096 || !filepath.IsAbs(request.Checkout) || len(request.Branches) > 64 {
		return 2
	}
	var extra any
	if in.Decode(&extra) != io.EOF {
		return 2
	}
	result := struct {
		Branches []capture.NoteBranchState `json:"branches"`
		Tags     []capture.NoteReleaseTag  `json:"tags"`
	}{Branches: capture.NoteBranchStates(request.Checkout, request.Branches)}
	if request.Tags {
		result.Tags = capture.NoteReleaseTags(request.Checkout)
	}
	if json.NewEncoder(stdout).Encode(result) != nil {
		return 2
	}
	return 0
}
