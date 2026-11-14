package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	localrecord "github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
	"modernc.org/sqlite"
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
func mexOnCheckout(t *testing.T, tmp, mexHome string) string {
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

func hookReadOnlyURI(location localrecord.Location) string {
	slash := filepath.ToSlash(location.Hooks)
	if !strings.HasPrefix(slash, "/") {
		slash = "/" + slash
	}
	uri := url.URL{Scheme: "file", Path: slash, RawQuery: "mode=ro"}
	return uri.String()
}

func prepareTimingHooks(t *testing.T, location localrecord.Location) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", location.Hooks)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	db.SetMaxOpenConns(1)
	schema, err := os.ReadFile(filepath.Join("..", "..", "record", "schema", "hooks", "0001_init.sql"))
	if err != nil {
		t.Fatal(err)
	}
	// Fixture preparation is outside the real hook's timed interval and limits.
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err = db.ExecContext(ctx, "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE;\n"+string(schema)+fmt.Sprintf("\nPRAGMA user_version=%d; COMMIT;", localrecord.SchemaVersion))
	if err != nil {
		t.Fatal(err)
	}
	return db
}

func hookCount(t *testing.T, location localrecord.Location) int {
	t.Helper()
	db, err := sql.Open("sqlite", hookReadOnlyURI(location))
	if err != nil {
		t.Fatal(err)
	}
	// Inspection must neither checkpoint/delete the warmed WAL nor hold a
	// connection open while timing. Observe the actual counter-writer state.
	defer db.Close()
	var count int
	if err := db.QueryRow("SELECT coalesce(sum(value),0) FROM counters_go WHERE name='agent:claude-code:hook.calls'").Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestHookCountInspectionIsReadOnly(t *testing.T) {
	location, err := localrecord.ResolveLocation(localrecord.LocationOptions{Home: t.TempDir(), Cache: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	initial := prepareTimingHooks(t, location)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	conn, err := initial.Conn(ctx)
	if err != nil {
		t.Fatal(err)
	}
	err = conn.Raw(func(driverConn any) error {
		fc, ok := driverConn.(sqlite.FileControl)
		if !ok {
			return fmt.Errorf("SQLite file control is unavailable")
		}
		_, err := fc.FileControlPersistWAL("main", 1)
		return err
	})
	_ = conn.Close()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := initial.ExecContext(ctx, "INSERT INTO counters_go VALUES('2026-11-13','agent:claude-code:hook.calls',1),('2026-11-13','agent:claude-code:hook.ms.0',1)"); err != nil {
		t.Fatal(err)
	}
	reader, err := sql.Open("sqlite", hookReadOnlyURI(location))
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	var version int
	if err := reader.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil || version != localrecord.SchemaVersion {
		t.Fatalf("fixture reader version=%d: %v", version, err)
	}
	if err := initial.Close(); err != nil {
		t.Fatal(err)
	}
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(location.Hooks)
	if err != nil {
		t.Fatal(err)
	}
	if count := hookCount(t, location); count != 1 {
		t.Fatalf("inspected count %d want 1", count)
	}
	after, err := os.ReadFile(location.Hooks)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatalf("count inspection checkpointed or changed the database: %v", err)
	}
	if _, err := os.Stat(location.Hooks + "-wal"); err != nil {
		t.Fatalf("count inspection removed the WAL: %v", err)
	}
}

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
	tmp := t.TempDir()
	mexHome := filepath.Join(tmp, "mex")
	payload = mexOnCheckout(t, tmp, mexHome)
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
		hooks := prepareTimingHooks(t, location)
		if err := hooks.Close(); err != nil {
			t.Fatal(err)
		}
	}

	for range 10 { // warm the file cache and any antivirus scan
		callOnce(t, shim, mexHome)
		callOnce(t, floor, mexHome)
	}
	before := 0
	if counters {
		before = hookCount(t, location)
	}
	const runs = 200
	// Measure actual captured calls. Best-effort storage may skip a call at its
	// production deadline, so allow a fixed number of extra fixture attempts.
	// Every retained latency still comes from a real persisted counter write.
	const maxCounterSkips = 10
	limit := runs
	if counters {
		limit += maxCounterSkips
	}
	shimRuns := make([]time.Duration, 0, runs)
	floorRuns := make([]time.Duration, 0, runs)
	attempts, last := 0, before
	for attempts < limit && len(shimRuns) < runs {
		attempts++
		shimTime := callOnce(t, shim, mexHome)
		floorTime := callOnce(t, floor, mexHome)
		if counters {
			// This observer closes before the next timed process and never writes.
			count := hookCount(t, location)
			if count == last {
				continue
			}
			if count != last+1 {
				t.Fatalf("counter count changed unexpectedly: before=%d after=%d", last, count)
			}
			last = count
		}
		shimRuns = append(shimRuns, shimTime)
		floorRuns = append(floorRuns, floorTime)
	}
	if len(shimRuns) != runs {
		t.Fatalf("counter capture samples: recorded=%d want=%d attempted=%d limit=%d", len(shimRuns), runs, attempts, limit)
	}
	if counters {
		if count := hookCount(t, location) - before; count != runs {
			t.Fatalf("counter sample count=%d want=%d", count, runs)
		}
		t.Logf("counter capture samples: recorded=%d attempted=%d skipped=%d limit=%d", runs, attempts, attempts-runs, limit)
	}

	s, f := summarize(shimRuns), summarize(floorRuns)

	line := fmt.Sprintf("mex-hook no-op on %s/%s: counters=%t runs=%d p50=%sms p95=%sms max=%sms | bare process p50=%sms p95=%sms",
		runtime.GOOS, runtime.GOARCH, counters, runs, ms(s.p50), ms(s.p95), ms(s.max), ms(f.p50), ms(f.p95))
	budget := time.Duration(defaultBudgetMs) * time.Millisecond
	if v, err := strconv.Atoi(os.Getenv("MEX_HOOK_BUDGET_MS")); err == nil && v > 0 {
		budget = time.Duration(v) * time.Millisecond
	}
	strict := strictTimingPassed(s, f, budget)
	detail, verdict := timingVerdict(os.Getenv("MEX_HOOK_TIMING_MODE"), runtime.GOOS, counters, s, f, budget)
	lines := []string{line, fmt.Sprintf("strict rule passed=%t (p95 budget=%sms, allowance over bare=%dms); bare process max=%sms", strict, ms(budget), overheadMs, ms(f.max)), detail}
	for _, entry := range lines {
		t.Log(entry)
	}
	if path := os.Getenv("MEX_HOOK_TIMING_OUT"); path != "" {
		file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
		if err != nil {
			t.Fatal(err)
		}
		_, writeErr := fmt.Fprintln(file, strings.Join(lines, "\n"))
		closeErr := file.Close()
		if writeErr != nil || closeErr != nil {
			t.Fatalf("write timing summary: %v; close: %v", writeErr, closeErr)
		}
	}
	if verdict != nil {
		t.Fatal(verdict)
	}
}
