package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	localrecord "github.com/mex-memory/mex/native/record"
)

// This opt-in measurement includes the real lifecycle transaction and the
// heartbeat, so it conservatively measures more than an open-only heartbeat.
func TestDeliveryOpenTiming(t *testing.T) {
	if os.Getenv("MEX_DELIVERY_MEASURE") != "1" {
		t.Skip("opt-in measurement")
	}
	t.Setenv("MEX_TELEMETRY", "0")
	t.Setenv("MEX_OFF", "")
	t.Setenv("MEX_BACKGROUND", "")
	shim, floor := buildBinaries(t)
	tmp := t.TempDir()
	home := filepath.Join(tmp, "home")
	payload = mexOnCheckout(t, tmp, home)
	var source map[string]any
	json.Unmarshal([]byte(payload), &source)
	source["source"] = "resume"
	source["hook_event_name"] = "SessionStart"
	body, _ := json.Marshal(source)
	invoke := func(bin, event string, body []byte) time.Duration {
		t.Helper()
		cmd := exec.Command(bin, "claude-code", event)
		cmd.Env = append(os.Environ(), "MEX_HOME="+home)
		cmd.Stdin = bytes.NewReader(body)
		start := time.Now()
		out, err := cmd.Output()
		d := time.Since(start)
		if err != nil || string(out) != "{}\n" {
			t.Fatal(err, string(out))
		}
		return d
	}
	open := func() time.Duration { return invoke(shim, "SessionStart", body) }
	for i := 0; i < 10; i++ {
		callOnce(t, shim, home)
		callOnce(t, floor, home)
		open()
	}
	// A silent reply could conceal a failed-open lifecycle, so inspect its row.
	beats, err := localrecord.HookHeartbeats(localrecord.Location{Hooks: filepath.Join(home, ".mex", "hooks.db")}, time.Now().Add(-time.Hour))
	if err != nil || len(beats["claude-code"]) != 1 {
		t.Fatal(beats, err)
	}
	var bare, noop, opened []time.Duration
	for i := 0; i < 200; i++ {
		bare = append(bare, callOnce(t, floor, home))
		noop = append(noop, callOnce(t, shim, home))
		opened = append(opened, open())
	}
	b, n, o := summarize(bare), summarize(noop), summarize(opened)
	t.Logf("200 interleaved runs: bare p50=%s p95=%s; no-op p50=%s p95=%s; lifecycle/open p50=%s p95=%s; added p95=%s", b.p50, b.p95, n.p50, n.p95, o.p50, o.p95, o.p95-n.p95)
}
