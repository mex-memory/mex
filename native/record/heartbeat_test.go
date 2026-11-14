package record

import (
	"os"
	"sort"
	"testing"
	"time"
)

func TestHookHeartbeatsReadOnlyAndThrottle(t *testing.T) {
	l := testLocation(t)
	if _, err := HookHeartbeats(l, time.Now()); err == nil {
		t.Fatal("missing database read succeeded")
	}
	if _, err := os.Stat(l.Hooks); !os.IsNotExist(err) {
		t.Fatal("status created database")
	}
	h, err := openHooks(l, testBudget)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	req := deliveryRequest()
	req.Candidates = nil
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	original := req.Now
	req.Now = req.Now.Add(20 * time.Second)
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	beats, err := HookHeartbeats(l, original.Add(-time.Hour))
	if err != nil || !beats["test"]["s"].Equal(original) {
		t.Fatal(beats, err)
	}
	req.Now = req.Now.Add(20 * time.Second)
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
	beats, err = HookHeartbeats(l, original.Add(-time.Hour))
	if err != nil || !beats["test"]["s"].Equal(req.Now) {
		t.Fatal(beats, err)
	}
}

func TestHooksOpenTiming(t *testing.T) {
	if os.Getenv("MEX_DELIVERY_MEASURE") != "1" {
		t.Skip("opt-in measurement")
	}
	l := testLocation(t)
	h, err := OpenHooks(l)
	if err != nil {
		t.Fatal(err)
	}
	h.Close()
	var times []time.Duration
	for i := 0; i < 200; i++ {
		start := time.Now()
		h, err = OpenHooks(l)
		if err != nil {
			t.Fatal(err)
		}
		if err = h.Close(); err != nil {
			t.Fatal(err)
		}
		times = append(times, time.Since(start))
	}
	sort.Slice(times, func(i, j int) bool { return times[i] < times[j] })
	t.Logf("OpenHooks+Close 200 runs: p50=%s p95=%s", times[99], times[189])
}
