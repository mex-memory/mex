package index

import (
	"encoding/json"
	"os"
	"testing"
)

// TestPeer answers index reads for src/file-index/__tests__/go-parity.test.ts,
// which compares them with Node's answers. It is a test-only bridge, never
// shipped. Without MEX_INDEX_PEER_QUERIES it does nothing.
func TestPeer(t *testing.T) {
	queries := os.Getenv("MEX_INDEX_PEER_QUERIES")
	if queries == "" {
		return
	}
	data, err := os.ReadFile(queries)
	if err != nil {
		t.Fatal(err)
	}
	var input struct {
		RecordDirectory string `json:"record_directory"`
		ProjectID       string `json:"project_id"`
		Checkout        string `json:"checkout"`
		Queries         []struct {
			Op   string   `json:"op"`
			Arg  string   `json:"arg"`
			Args []string `json:"args"`
		} `json:"queries"`
	}
	if err := json.Unmarshal(data, &input); err != nil {
		t.Fatal(err)
	}
	reader, err := Open(input.RecordDirectory, input.ProjectID, input.Checkout)
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	answers := []any{}
	for _, q := range input.Queries {
		var answer any
		switch q.Op {
		case "outline":
			if out, miss := reader.Outline(q.Arg); miss != nil {
				answer = miss
			} else {
				answer = out
			}
		case "fileInfo":
			if out, miss := reader.FileInfo(q.Arg); miss != nil {
				answer = miss
			} else {
				answer = out
			}
		case "filesNamed":
			answer, err = reader.FilesNamed(q.Arg)
		case "symbolsNamed":
			answer, err = reader.SymbolsNamed(q.Arg)
		case "patternCounts":
			answer, err = reader.PatternCounts(q.Arg, q.Args)
		case "coverage":
			answer, err = reader.Coverage(q.Arg)
		default:
			t.Fatalf("unknown op %s", q.Op)
		}
		if err != nil {
			t.Fatal(err)
		}
		answers = append(answers, answer)
	}
	encoded, _ := json.Marshal(answers)
	if err := os.WriteFile(os.Getenv("MEX_INDEX_PEER_OUT"), encoded, 0o600); err != nil {
		t.Fatal(err)
	}
}
