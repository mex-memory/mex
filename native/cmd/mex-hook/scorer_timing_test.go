package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Opt-in, whole-process measurement with fresh sessions so every sample
// delivers, rather than timing deduped hits. No model or network is involved.
func TestScorerDeliveryTiming(t *testing.T) {
	if os.Getenv("MEX_DELIVERY_MEASURE") != "1" {
		t.Skip("opt-in measurement")
	}
	t.Setenv("MEX_TELEMETRY", "0")
	t.Setenv("MEX_OFF", "")
	t.Setenv("MEX_BACKGROUND", "")
	base := os.Getenv("MEX_DELIVERY_BASE_BINARY")
	if base == "" {
		t.Skip("interleaved base binary required")
	}
	shim, floor := buildBinaries(t)
	tmp := t.TempDir()
	home := filepath.Join(tmp, "home")
	payload = mexOnCheckout(t, tmp, home)
	var source map[string]any
	if err := json.Unmarshal([]byte(payload), &source); err != nil {
		t.Fatal(err)
	}
	repo := source["cwd"].(string)
	baseHome := filepath.Join(tmp, "base-home")
	os.MkdirAll(filepath.Join(baseHome, ".mex", "hook-checkouts"), 0700)
	for _, sub := range []string{"hook-checkouts", ""} {
		children, _ := os.ReadDir(filepath.Join(home, ".mex", sub))
		for _, child := range children {
			if child.IsDir() {
				continue
			}
			b, err := os.ReadFile(filepath.Join(home, ".mex", sub, child.Name()))
			if err != nil {
				t.Fatal(err)
			}
			if err = os.WriteFile(filepath.Join(baseHome, ".mex", sub, child.Name()), b, 0600); err != nil {
				t.Fatal(err)
			}
		}
	}
	learned := filepath.Join(repo, ".mex", "learned")
	if err := os.MkdirAll(learned, 0700); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 500; i++ {
		scope := fmt.Sprintf("src/other%d.ts", i)
		if i == 0 {
			scope = "src/a.ts"
		}
		id := fmt.Sprintf("mx_perf%04d", i)
		body := fmt.Sprintf("---\nmex:\n  id: %s\n  kind: pitfall\n  scope: [%q]\n  source: {type: docs, ref: CONTRIBUTING.md}\n  evidence: docs\n  one_line: Keep the shared pool open.\n  checks: []\n  status: active\n  created: 2026-11-03\n---\nKeep the shared pool open because every request reuses it.\n", id, scope)
		if err := os.WriteFile(filepath.Join(learned, id+".md"), []byte(body), 0600); err != nil {
			t.Fatal(err)
		}
	}
	past := time.Now().Add(-5 * time.Second)
	names, err := os.ReadDir(learned)
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range names {
		if err := os.Chtimes(filepath.Join(learned, e.Name()), past, past); err != nil {
			t.Fatal(err)
		}
	}
	calls := []map[string]any{{"tool_name": "Read", "tool_input": map[string]any{"file_path": filepath.Join(repo, "src", "a.ts")}, "tool_use_id": "1", "tool_response": "1\tconst pool = sharedPool;\n"}}
	invoke := func(bin, scorer, session string) time.Duration {
		body, err := json.Marshal(map[string]any{"session_id": session, "cwd": repo, "hook_event_name": "PostToolBatch", "tool_calls": calls})
		if err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command(bin, "claude-code", "PostToolBatch", "--delivery-trace")
		activeHome := home
		if bin == base {
			activeHome = baseHome
		}
		cmd.Env = append(os.Environ(), "MEX_HOME="+activeHome, "MEX_DELIVERY_SCORER="+scorer)
		cmd.Stdin = bytes.NewReader(body)
		var diagnostics bytes.Buffer
		cmd.Stderr = &diagnostics
		start := time.Now()
		out, err := cmd.Output()
		elapsed := time.Since(start)
		if err != nil {
			t.Fatal(err)
		}
		if (bin == shim || bin == base) && !strings.Contains(string(out), "Keep the shared pool open because") {
			t.Errorf("%s binary=%s session=%s: %s", scorer, filepath.Base(bin), session, append(out, diagnostics.Bytes()...))
		}
		return elapsed
	}
	runs := 200
	if raw := os.Getenv("MEX_DELIVERY_MEASURE_RUNS"); raw != "" {
		var err error
		runs, err = strconv.Atoi(raw)
		if err != nil || runs < 200 || runs > 5000 {
			t.Fatal("measurement runs must be between 200 and 5000")
		}
	}
	for _, scorer := range []string{"tiers", "bm25", "fcfs", "risk"} {
		if selected := os.Getenv("MEX_DELIVERY_MEASURE_SCORER"); selected != "" && selected != scorer {
			continue
		}
		for i := 0; i < 5; i++ {
			invoke(shim, scorer, fmt.Sprintf("warm-%s-%d", scorer, i))
			invoke(base, scorer, fmt.Sprintf("warm-%s-%d", scorer, i))
		}
		var bare, delivery, baseline, delta []time.Duration
		for i := 0; i < runs; i++ {
			bare = append(bare, invoke(floor, scorer, "bare"))
			var b, d time.Duration
			session := fmt.Sprintf("measure-%s-%d", scorer, i)
			if i%2 == 0 {
				b = invoke(base, scorer, session)
				d = invoke(shim, scorer, session)
			} else {
				d = invoke(shim, scorer, session)
				b = invoke(base, scorer, session)
			}
			baseline = append(baseline, b)
			delivery = append(delivery, d)
			delta = append(delta, d-b)
		}
		db, err := sql.Open("sqlite", filepath.Join(home, ".mex", "hooks.db"))
		if err != nil {
			t.Fatal(err)
		}
		var count, minTokens, maxTokens, sum int
		err = db.QueryRow("SELECT count(*),min(tokens),max(tokens),sum(tokens) FROM deliveries WHERE action='given' AND session_id LIKE ?", "measure-"+scorer+"-%").Scan(&count, &minTokens, &maxTokens, &sum)
		db.Close()
		if err != nil || count != runs {
			t.Errorf("receipts=%d want=%d error=%v", count, runs, err)
		}
		b, d := summarize(bare), summarize(delivery)
		baseStats, diff := summarize(baseline), summarize(delta)
		t.Logf("scorer=%s entries=500 paired runs=%d base p50=%s p95=%s; current p50=%s p95=%s; paired delta p50=%s p95=%s (ms)", scorer, runs, ms(baseStats.p50), ms(baseStats.p95), ms(d.p50), ms(d.p95), ms(diff.p50), ms(diff.p95))
		t.Logf("scorer=%s entries=500 fresh-delivery runs=%d: bare p50=%s p95=%s; delivery p50=%s p95=%s (ms); receipt tokens min=%d max=%d mean=%.2f (estimated tokens, counted receipts=%d)", scorer, runs, ms(b.p50), ms(b.p95), ms(d.p50), ms(d.p95), minTokens, maxTokens, float64(sum)/float64(count), count)
	}
}
