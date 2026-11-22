package check

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/mex-memory/mex/native/delivery/entries"
)

func TestLearnedEntryCodecParity(t *testing.T) {
	pattern := filepath.Join("..", "delivery", "entries", "testdata", "learn-deeper", "*.md")
	paths, err := filepath.Glob(pattern)
	if err != nil || len(paths) != 8 {
		t.Fatalf("got %d fixtures: %v", len(paths), err)
	}
	for _, path := range paths {
		t.Run(filepath.Base(path), func(t *testing.T) {
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			var expected struct {
				Mex struct {
					Fix    *entries.Fix      `json:"fix"`
					Source entries.Source    `json:"source"`
					When   []entries.Trigger `json:"when"`
					Checks []entries.Check   `json:"checks"`
				} `json:"mex"`
			}
			frontmatter := bytes.Split(bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n")), []byte("---\n"))[1]
			if err := json.Unmarshal(frontmatter, &expected); err != nil {
				t.Fatal(err)
			}
			evaluator, err := ParseEntry(data)
			if err != nil {
				t.Fatal(err)
			}
			delivery, err := entries.Parse(data)
			if err != nil {
				t.Fatal(err)
			}
			same := func(field string, want, first, second any) {
				t.Helper()
				expected, _ := json.Marshal(want)
				a, _ := json.Marshal(first)
				b, _ := json.Marshal(second)
				if !bytes.Equal(expected, a) || !bytes.Equal(expected, b) {
					t.Errorf("%s: want %s, evaluator %s, delivery %s", field, expected, a, b)
				}
			}
			same("fix", expected.Mex.Fix, evaluator.Fix, delivery.Fix)
			same("source", expected.Mex.Source, evaluator.Source, delivery.Source)
			same("when", expected.Mex.When, evaluator.When, delivery.When)
			same("checks", expected.Mex.Checks, evaluator.Checks, delivery.Checks)
		})
	}
}
