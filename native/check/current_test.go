package check

import (
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/delivery/entries"
)

func TestEmptyFloorExactPatternCacheIdentityReadsItsSource(t *testing.T) {
	root := t.TempDir()
	write(t, root, "api.ts", "first\n")
	l := Loaded{Hash: hashBytes([]byte("entry")), Entry: &Entry{Checks: []Check{{Kind: "pattern", Target: map[string]any{"scope": "api.ts", "pattern": "first", "match": "literal"}, Files: map[string]string{}}}}}
	identity := func() string {
		ev, err := NewEvaluator(root)
		if err != nil {
			t.Fatal(err)
		}
		defer ev.Close()
		return ev.inputsHash(l, "same-index")
	}
	old := identity()
	write(t, root, "api.ts", "edited without refreshing the index\n")
	if old == identity() {
		t.Fatal("an older exact-scope check reused a cache key after its source changed")
	}
}

func TestDeliveryIdentityMatchesStageWithinModelEvidenceBounds(t *testing.T) {
	root := t.TempDir()
	write(t, root, "api.ts", "export const timeout = 30;\n")
	c := record(t, root, "source", Supporting, map[string]any{"file": "api.ts"})
	teamEntry(t, root, "mx_inputs00", c)
	identity := func() (string, string) {
		t.Helper()
		r, err := RunStage(StageOptions{Checkout: root})
		if err != nil {
			t.Fatal(err)
		}
		item := &entries.Item{Hash: r.Items[0].EntryHash, Entry: &entries.Entry{Checks: []entries.Check{{Kind: c.Kind, Role: c.Role, Target: c.Target, Saw: c.Saw, Files: c.Files}}}}
		current, ok := CurrentInputsHash(root, "", "p", item)
		if !ok {
			t.Fatal("current inputs unavailable")
		}
		return r.Results[0].EvaluationHash, current
	}
	stage, current := identity()
	if stage != current {
		t.Fatal("delivery used a different native identity")
	}
	write(t, root, "api.ts", strings.Repeat("x", 65<<10))
	stage, current = identity()
	if stage == current {
		t.Fatal("delivery read beyond the judge's 64 KiB evidence bound")
	}
}
