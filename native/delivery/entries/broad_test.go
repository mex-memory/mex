package entries

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestBroadLearnedScopeParity(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "test", "fixtures", "knowledge", "broad-learned.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name          string
		Scopes, Paths []string
		Broad         bool
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			classify := BroadLearned(func() []string { return tc.Paths })
			entry := Entry{ID: "mx_deeptest", Scope: tc.Scopes}
			if got := classify(&entry); got != tc.Broad {
				t.Fatalf("broad = %v, want %v", got, tc.Broad)
			}
			entry.ID = "mx_person1"
			if classify(&entry) {
				t.Fatal("ordinary entry was classified as broad learned")
			}
		})
	}
}
