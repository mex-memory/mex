package check

import "testing"

func TestSnapshotNeverFallsBackToCheckoutOrTreatsUnavailableAsMissing(t *testing.T) {
	text := `{"use":"old"}`
	e := &Entry{ID: "mx_advice", Status: "active", Checks: []Check{{Kind: "key", Role: Complete, Target: map[string]any{"file": "config.json", "pointer": "/use"}, Saw: map[string]any{"value": "old"}, Files: map[string]string{"config.json": hashBytes([]byte(text))}}}}
	for _, tc := range []struct {
		files   map[string]*string
		verdict string
	}{{map[string]*string{"config.json": &text}, Held}, {map[string]*string{}, Changed}, {map[string]*string{"config.json": nil}, Broken}} {
		ev, err := NewSnapshotEvaluator(tc.files)
		if err != nil {
			t.Fatal(err)
		}
		got := ev.Evaluate(e)
		ev.Close()
		if got.Verdict != tc.verdict {
			t.Fatal(got)
		}
	}
	if _, err := NewSnapshotEvaluator(map[string]*string{"../escape": &text}); err == nil {
		t.Fatal("accepted escape")
	}
}
