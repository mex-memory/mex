package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/record/place"
)

// The no-op budget: a hook that has nothing to do answers in 17 ms or less at
// p95, measured as wall time of the whole process.
const defaultBudgetMs = 17

// Process start alone can exceed the budget on a loaded machine. The test then
// checks the part the shim controls: its p95 may be at most this much slower
// than a bare Go program that only prints the reply.
const overheadMs = 3

// payload is a Read inside a checkout where MEX is on, so the timed path is the
// full one: parse, heartbeat, checkout lookup, render.
var payload string

// mexOnCheckout makes a checkout with MEX on in the throwaway MEX folder and
// returns a payload reading a file in it.
func mexOnCheckout(t *testing.T, tmp string) string {
	t.Helper()
	repo := filepath.Join(tmp, "repo")
	file := filepath.Join(repo, "src", "a.ts")
	for _, dir := range []string{filepath.Join(repo, ".git"), filepath.Dir(file), filepath.Join(mexHome, ".mex", "hook-checkouts")} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	_ = os.WriteFile(file, []byte("export const a = 1;\n"), 0o600)
	root, err := place.RealPath(repo)
	if err != nil {
		t.Fatal(err)
	}
	mirror, _ := json.Marshal(map[string]any{"version": 1, "project_id": "g-0123456789abcdef01234567", "root": root, "state": "on", "off_until": "", "provisional": false})
	_ = os.WriteFile(filepath.Join(mexHome, ".mex", "hook-checkouts", place.ShortHash(root)+".json"), mirror, 0o600)
	body, _ := json.Marshal(map[string]any{
		"hook_event_name": "PreToolUse", "session_id": "timing", "cwd": repo,
		"tool_name": "Read", "tool_input": map[string]any{"file_path": file},
	})
	return string(body)
}

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

// mexHome is a throwaway MEX folder, so the timing runs include the heartbeat
// write without touching the real ~/.mex.
var mexHome string

func callOnce(t *testing.T, bin string) time.Duration {
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
	if testing.Short() {
		t.Skip("timing test skipped in -short mode")
	}
	shim, floor := buildBinaries(t)
	tmp := t.TempDir()
	mexHome = filepath.Join(tmp, "mex")
	payload = mexOnCheckout(t, tmp)

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
	if s.p95 <= budget {
		return
	}
	if s.p95 > f.p95+overheadMs*time.Millisecond {
		t.Fatalf("p95 %sms is over the %sms budget and %sms over a bare process",
			ms(s.p95), ms(budget), ms(s.p95-f.p95))
	}
	t.Logf("p95 is over budget, but within %dms of a bare process: the machine is slow, not the shim", overheadMs)
}
