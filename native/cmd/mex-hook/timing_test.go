package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"testing"
	"time"
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

func callOnce(t *testing.T, bin string) time.Duration {
	t.Helper()
	cmd := exec.Command(bin)
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
	if testing.Short() {
		t.Skip("timing test skipped in -short mode")
	}
	shim, floor := buildBinaries(t)

	for range 10 { // warm the file cache and any antivirus scan
		callOnce(t, shim)
		callOnce(t, floor)
	}
	const runs = 200
	shimRuns := make([]time.Duration, runs)
	floorRuns := make([]time.Duration, runs)
	for i := range runs { // interleaved, so machine load hits both alike
		shimRuns[i] = callOnce(t, shim)
		floorRuns[i] = callOnce(t, floor)
	}
	s, f := summarize(shimRuns), summarize(floorRuns)

	line := fmt.Sprintf("mex-hook no-op on %s/%s: runs=%d p50=%sms p95=%sms max=%sms | bare process p50=%sms p95=%sms",
		runtime.GOOS, runtime.GOARCH, runs, ms(s.p50), ms(s.p95), ms(s.max), ms(f.p50), ms(f.p95))
	t.Log(line)
	if path := os.Getenv("MEX_HOOK_TIMING_OUT"); path != "" {
		_ = os.WriteFile(path, []byte(line+"\n"), 0o644)
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
