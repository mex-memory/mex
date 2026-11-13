package main

import (
	"bytes"
	"database/sql"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"testing"
	"time"

	localrecord "github.com/mex-memory/mex/native/record"
)

// The no-op budget: a hook that has nothing to do answers in 17 ms or less,
// measured as wall time of the whole process.
const defaultBudgetMs = 17

// Process start alone can exceed the budget on a loaded machine. The test then
// checks the part the shim controls: its median may be at most this much slower
// than a bare Go program that only prints the reply.
const overheadMs = 3

const payload = `{"hook_event_name":"PreToolUse","session_id":"timing","tool_name":"Read","tool_input":{"file_path":"/tmp/x"}}`

const floorSource = `package main

import "os"

func main() { os.Stdout.Write([]byte("{}\n")) }
`

func exe(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

func goBuild(t *testing.T, dir, out string) {
	t.Helper()
	cmd := exec.Command("go", "build", "-trimpath", "-ldflags", "-s -w", "-o", out, ".")
	cmd.Dir = dir
	if b, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("build in %s: %v\n%s", dir, err, b)
	}
}

func buildBinaries(t *testing.T) (shim, floor string) {
	t.Helper()
	tmp := t.TempDir()
	shim = filepath.Join(tmp, exe("mex-hook"))
	goBuild(t, ".", shim)

	src := filepath.Join(tmp, "floor-src")
	if err := os.MkdirAll(src, 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(src, "go.mod"), []byte("module floor\n\ngo 1.24\n"), 0o644)
	_ = os.WriteFile(filepath.Join(src, "main.go"), []byte(floorSource), 0o644)
	floor = filepath.Join(tmp, exe("floor"))
	goBuild(t, src, floor)
	return shim, floor
}

func callOnce(t *testing.T, bin, mexHome string) time.Duration {
	t.Helper()
	// The bare process ignores its arguments; the shim parses the payload.
	cmd := exec.Command(bin, "claude-code", "PreToolUse")
	cmd.Env = append(os.Environ(), "MEX_HOME="+mexHome)
	cmd.Stdin = bytes.NewBufferString(payload)
	var out bytes.Buffer
	cmd.Stdout = &out
	start := time.Now()
	err := cmd.Run()
	d := time.Since(start)
	if err != nil {
		t.Fatalf("%s exited with error: %v", bin, err)
	}
	if out.String() != "{}\n" {
		t.Fatalf("%s replied %q", bin, out.String())
	}
	return d
}

type stats struct{ p50, p95, max time.Duration }

func summarize(s []time.Duration) stats {
	sort.Slice(s, func(i, j int) bool { return s[i] < s[j] })
	n := len(s)
	return stats{s[n/2], s[n*95/100], s[n-1]}
}

func ms(d time.Duration) string {
	return strconv.FormatFloat(float64(d.Microseconds())/1000, 'f', 2, 64)
}

func TestNoOpTiming(t *testing.T) {
	measureNoOp(t, false)
}

func TestNoOpTimingWithCounters(t *testing.T) {
	measureNoOp(t, true)
}

func measureNoOp(t *testing.T, counters bool) {
	t.Helper()
	if testing.Short() {
		t.Skip("timing test skipped in -short mode")
	}
	shim, floor := buildBinaries(t)
	mexHome := t.TempDir()
	if err := os.MkdirAll(filepath.Join(mexHome, ".mex"), 0o700); err != nil {
		t.Fatal(err)
	}
	var location localrecord.Location
	if counters {
		// Exercise the default-on production path even on CI. Everything is
		// isolated by MEX_HOME and the hook cannot send network requests.
		for _, key := range []string{"DO_NOT_TRACK", "MEX_TELEMETRY", "MEX_OFFLINE", "MEX_DEV", "CI", "CONTINUOUS_INTEGRATION", "GITHUB_ACTIONS", "GITLAB_CI", "TF_BUILD", "BUILDKITE", "CIRCLECI", "JENKINS_URL"} {
			t.Setenv(key, "")
		}
		var err error
		location, err = localrecord.ResolveLocation(localrecord.LocationOptions{Home: filepath.Join(mexHome, ".mex")})
		if err != nil {
			t.Fatal(err)
		}
	}

	for range 10 { // warm the file cache and any antivirus scan
		callOnce(t, shim, mexHome)
		callOnce(t, floor, mexHome)
	}
	const runs = 200
	shimRuns := make([]time.Duration, runs)
	floorRuns := make([]time.Duration, runs)
	for i := range runs { // interleaved, so machine load hits both alike
		shimRuns[i] = callOnce(t, shim, mexHome)
		floorRuns[i] = callOnce(t, floor, mexHome)
	}
	if counters {
		db, err := sql.Open("sqlite", location.Hooks)
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()
		var count int
		if err := db.QueryRow("SELECT sum(value) FROM counters_go WHERE name='agent:claude-code:hook.calls'").Scan(&count); err != nil || count != runs+10 {
			t.Fatalf("counter path was not measured: count=%d err=%v", count, err)
		}
	}
	s, f := summarize(shimRuns), summarize(floorRuns)

	line := fmt.Sprintf("mex-hook no-op on %s/%s: counters=%t runs=%d p50=%sms p95=%sms max=%sms | bare process p50=%sms p95=%sms",
		runtime.GOOS, runtime.GOARCH, counters, runs, ms(s.p50), ms(s.p95), ms(s.max), ms(f.p50), ms(f.p95))
	t.Log(line)
	if path := os.Getenv("MEX_HOOK_TIMING_OUT"); path != "" {
		file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := fmt.Fprintln(file, line); err != nil {
			file.Close()
			t.Fatal(err)
		}
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}
	}

	budget := time.Duration(defaultBudgetMs) * time.Millisecond
	if v, err := strconv.Atoi(os.Getenv("MEX_HOOK_BUDGET_MS")); err == nil && v > 0 {
		budget = time.Duration(v) * time.Millisecond
	}
	if s.p50 <= budget {
		return
	}
	if s.p50 > f.p50+overheadMs*time.Millisecond {
		t.Fatalf("p50 %sms is over the %sms budget and %sms over a bare process",
			ms(s.p50), ms(budget), ms(s.p50-f.p50))
	}
	t.Logf("p50 is over budget, but within %dms of a bare process: the machine is slow, not the shim", overheadMs)
}
