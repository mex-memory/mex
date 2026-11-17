package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestNoOpBaseComparison(t *testing.T) {
	base := os.Getenv("MEX_DELIVERY_BASE_BINARY")
	if os.Getenv("MEX_DELIVERY_MEASURE") != "1" || base == "" {
		t.Skip("opt-in interleaved comparison")
	}
	t.Setenv("MEX_TELEMETRY", "0")
	t.Setenv("MEX_OFF", "")
	t.Setenv("MEX_BACKGROUND", "")
	shim, _ := buildBinaries(t)
	tmp := t.TempDir()
	home := filepath.Join(tmp, "home")
	payload = mexOnCheckout(t, tmp, home)
	for i := 0; i < 10; i++ {
		callOnce(t, base, home)
		callOnce(t, shim, home)
	}
	var old, current, delta []time.Duration
	for i := 0; i < 200; i++ {
		var a, b time.Duration
		if i%2 == 0 {
			a = callOnce(t, base, home)
			b = callOnce(t, shim, home)
		} else {
			b = callOnce(t, shim, home)
			a = callOnce(t, base, home)
		}
		old = append(old, a)
		current = append(current, b)
		delta = append(delta, b-a)
	}
	a, b, d := summarize(old), summarize(current), summarize(delta)
	t.Logf("no-op paired runs=200 base p50=%s p95=%s; current p50=%s p95=%s; paired delta p50=%s p95=%s (ms)", ms(a.p50), ms(a.p95), ms(b.p50), ms(b.p95), ms(d.p50), ms(d.p95))
	if _, err := os.Stat(filepath.Join(home, ".mex", "hooks.db")); !os.IsNotExist(err) {
		t.Fatal("no-op opened SQLite", err)
	}
}
