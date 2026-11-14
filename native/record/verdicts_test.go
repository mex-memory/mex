package record

import (
	"testing"
	"time"
)

func TestVerdicts(t *testing.T) {
	hooks, err := openHooks(testLocation(t), testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer hooks.Close()
	var many []Verdict
	for i := 0; i < 250; i++ {
		many = append(many, Verdict{EntryID: "mx_" + string(rune('a'+i%26)) + time.Duration(i).String(), Verdict: "held", InputsHash: "sha256:a", CheckedAt: "2026-11-14T00:00:00Z"})
	}
	many = append(many, Verdict{EntryID: "mx_cors01", Verdict: "held", InputsHash: "sha256:a", CheckedAt: "2026-11-14T00:00:00Z"})
	if err := hooks.PutVerdicts("p1", "/repo", many); err != nil {
		t.Fatal(err)
	}
	if err := hooks.PutVerdicts("p1", "/repo", []Verdict{{EntryID: "mx_cors01", Verdict: "broken", InputsHash: "sha256:b", CheckedAt: "2026-11-14T00:01:00Z"}}); err != nil {
		t.Fatal(err)
	}
	if err := hooks.PutVerdicts("p1", "/other", []Verdict{{EntryID: "mx_cors01", Verdict: "held", InputsHash: "sha256:c", CheckedAt: "2026-11-14T00:01:00Z"}}); err != nil {
		t.Fatal(err)
	}
	v, ok, err := hooks.VerdictOf("p1", "/repo", "mx_cors01")
	if err != nil || !ok || v.Verdict != "broken" || v.InputsHash != "sha256:b" {
		t.Fatalf("one: %+v %v %v", v, ok, err)
	}
	if _, ok, err := hooks.VerdictOf("p1", "/repo", "mx_nope01"); ok || err != nil {
		t.Fatalf("missing: %v %v", ok, err)
	}
	all, err := hooks.Verdicts("p1", "/repo")
	if err != nil || len(all) != 251 {
		t.Fatalf("all: %d %v", len(all), err)
	}
	if err := hooks.DropVerdicts("p1", "/repo", []string{"mx_cors01"}); err != nil {
		t.Fatal(err)
	}
	if all, _ := hooks.Verdicts("p1", "/repo"); len(all) != 1 {
		t.Fatalf("after drop: %d", len(all))
	}
	if other, _ := hooks.Verdicts("p1", "/other"); len(other) != 1 {
		t.Fatalf("other checkout touched: %d", len(other))
	}
	if err := hooks.PutVerdicts("p1", "/repo", []Verdict{{EntryID: "mx_x00001", Verdict: "fine", InputsHash: "x", CheckedAt: "x"}}); err == nil {
		t.Fatal("an unknown verdict was stored")
	}

	// The delivery gate's read is a primary-key lookup.
	started := time.Now()
	for i := 0; i < 1000; i++ {
		if _, _, err := hooks.VerdictOf("p1", "/repo", "mx_cors01"); err != nil {
			t.Fatal(err)
		}
	}
	t.Logf("one verdict read: %s", time.Since(started)/1000)
}
