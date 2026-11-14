package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestDeliveryBatchTiming measures the delivering path through the real
// binary: Claude Code PostToolBatch payloads with 1, 4 and 10 reads, against
// stores of 50 and 500 entries, interleaved with the bare process. Opt-in
// (MEX_DELIVERY_MEASURE=1) because it prints numbers rather than asserting a
// machine-specific budget; the no-op timing test keeps the budget.
//
//   - miss: the reads touch no entry's scope, so no SQLite is opened.
//   - hit: every read has a pitfall that was already given, so each call
//     opens hooks.db and runs the ledger transaction, then stays silent.
func TestDeliveryBatchTiming(t *testing.T) {
	if os.Getenv("MEX_DELIVERY_MEASURE") != "1" {
		t.Skip("opt-in measurement")
	}
	t.Setenv("MEX_TELEMETRY", "0")
	t.Setenv("MEX_OFF", "")
	t.Setenv("MEX_BACKGROUND", "")
	shim, floor := buildBinaries(t)
	runs := 200
	for _, size := range []int{50, 500} {
		tmp := t.TempDir()
		home := filepath.Join(tmp, "home")
		payload = mexOnCheckout(t, tmp, home)
		var p map[string]any
		_ = json.Unmarshal([]byte(payload), &p)
		repo := p["cwd"].(string)
		learned := filepath.Join(repo, ".mex", "learned")
		_ = os.MkdirAll(learned, 0o700)
		for i := 0; i < size; i++ {
			id := fmt.Sprintf("mx_t%05d", i)
			body := fmt.Sprintf("---\nmex:\n  id: %s\n  kind: pitfall\n  scope:\n    - \"src/hit%d.ts\"\n  source:\n    type: docs\n    ref: CONTRIBUTING.md\n  evidence: docs\n  one_line: \"Pitfall %d for its file.\"\n  checks: []\n  status: active\n  created: 2026-11-03\n---\nPitfall %d for its file, with a reason.\n", id, i, i, i)
			_ = os.WriteFile(filepath.Join(learned, id+".md"), []byte(body), 0o600)
		}
		past := time.Now().Add(-5 * time.Second)
		entries, _ := os.ReadDir(learned)
		for _, e := range entries {
			_ = os.Chtimes(filepath.Join(learned, e.Name()), past, past)
		}
		batch := func(n int, hit bool) []byte {
			var calls []map[string]any
			for i := 0; i < n; i++ {
				name := fmt.Sprintf("miss%d.ts", i)
				if hit {
					name = fmt.Sprintf("hit%d.ts", i)
				}
				calls = append(calls, map[string]any{"tool_name": "Read", "tool_input": map[string]any{"file_path": filepath.Join(repo, "src", name)}, "tool_use_id": fmt.Sprint(i), "tool_response": "1\tconst x = 1\n"})
			}
			b, _ := json.Marshal(map[string]any{"session_id": "timing", "cwd": repo, "hook_event_name": "PostToolBatch", "tool_calls": calls})
			return b
		}
		invoke := func(bin string, body []byte) (time.Duration, string) {
			cmd := exec.Command(bin, "claude-code", "PostToolBatch")
			cmd.Env = append(os.Environ(), "MEX_HOME="+home)
			cmd.Stdin = bytes.NewReader(body)
			start := time.Now()
			out, err := cmd.Output()
			d := time.Since(start)
			if err != nil {
				t.Fatal(err)
			}
			return d, string(out)
		}
		for _, n := range []int{1, 4, 10} {
			miss, hit := batch(n, false), batch(n, true)
			// First hit call delivers; check it really did.
			if _, out := invoke(shim, hit); !strings.Contains(out, fmt.Sprintf("Pitfall %d for its file", n-1)) {
				t.Fatalf("hit batch delivered nothing: %s", out)
			}
			for i := 0; i < 5; i++ {
				invoke(floor, miss)
				invoke(shim, miss)
				invoke(shim, hit)
			}
			var bare, missD, hitD []time.Duration
			for i := 0; i < runs; i++ {
				d, _ := invoke(floor, miss)
				bare = append(bare, d)
				d, out := invoke(shim, miss)
				if out != "{}\n" {
					t.Fatalf("miss replied %q", out)
				}
				missD = append(missD, d)
				d, out = invoke(shim, hit)
				if out != "{}\n" {
					t.Fatalf("repeat hit replied %q", out)
				}
				hitD = append(hitD, d)
			}
			b, m, h := summarize(bare), summarize(missD), summarize(hitD)
			t.Logf("entries=%d tools=%d runs=%d: bare p50=%s p95=%s | miss p50=%s p95=%s | hit p50=%s p95=%s (ms)", size, n, runs, ms(b.p50), ms(b.p95), ms(m.p50), ms(m.p95), ms(h.p50), ms(h.p95))
		}
	}
}
