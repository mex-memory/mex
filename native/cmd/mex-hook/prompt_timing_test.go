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

func TestPromptBaseComparison(t *testing.T) {
	base := os.Getenv("MEX_DELIVERY_BASE_BINARY")
	if os.Getenv("MEX_DELIVERY_MEASURE") != "1" || base == "" {
		t.Skip("opt-in interleaved base comparison")
	}
	t.Setenv("MEX_TELEMETRY", "0")
	t.Setenv("MEX_OFF", "")
	t.Setenv("MEX_BACKGROUND", "")
	shim, _ := buildBinaries(t)
	for _, count := range []int{50, 500} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			tmp := t.TempDir()
			home := filepath.Join(tmp, "home")
			payload = mexOnCheckout(t, tmp, home)
			var source map[string]any
			json.Unmarshal([]byte(payload), &source)
			repo := source["cwd"].(string)
			learned := filepath.Join(repo, ".mex", "learned")
			os.MkdirAll(learned, 0700)
			for i := 0; i < count; i++ {
				title, body := fmt.Sprintf("Unrelated storage convention number %d.", i), fmt.Sprintf("Module number %d keeps its own independent storage convention.", i)
				if i == 0 {
					title = "Keep sharedPool alive in src/a.ts."
					body = "Requests use `sharedPool` from `src/a.ts` because a shared pool stays alive across requests."
				}
				scope := fmt.Sprintf("src/other%d.ts", i)
				if i == 0 {
					scope = "src/a.ts"
				}
				entry := fmt.Sprintf("---\nmex:\n  id: mx_prompt%04d\n  kind: pitfall\n  scope: [%q]\n  source: {type: docs, ref: CONTRIBUTING.md}\n  evidence: docs\n  one_line: %s\n  checks: []\n  status: active\n  created: 2026-11-03\n---\n%s\n", i, scope, title, body)
				if err := os.WriteFile(filepath.Join(learned, fmt.Sprintf("mx_prompt%04d.md", i)), []byte(entry), 0600); err != nil {
					t.Fatal(err)
				}
				past := time.Now().Add(-5 * time.Second)
				os.Chtimes(filepath.Join(learned, fmt.Sprintf("mx_prompt%04d.md", i)), past, past)
			}
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
			for _, mode := range []string{"abstain", "deliver"} {
				phases := map[string][]time.Duration{}
				invoke := func(bin, activeHome, session string, reference, measured bool) (time.Duration, bool) {
					input := map[string]any{"session_id": mode + session, "cwd": repo}
					event := "UserPromptSubmit"
					if mode == "abstain" {
						// Task-sized text exercises long-prompt windows even when
						// the vocabulary offers no relevant item in this fixture.
						input["prompt"] = strings.Repeat("Implement authentication middleware composition for route handlers. "+
							"Support multiple credentials with deterministic precedence and preserve headers throughout the handler chain. "+
							"Verify missing authorization, malformed bearer credentials, expired credentials and revoked keys. "+
							"Cover nested routers, composed handlers, signature validation and authorization precedence. ", 4)
					} else if reference {
						event = "PostToolBatch"
						input["tool_calls"] = []map[string]any{{"tool_name": "Read", "tool_input": map[string]any{"file_path": filepath.Join(repo, "src", "a.ts")}, "tool_use_id": "1", "tool_response": "const pool = sharedPool;"}}
					} else {
						input["prompt"] = "How should sharedPool from src/a.ts handle requests?"
					}
					body, _ := json.Marshal(input)
					cmd := exec.Command(bin, "claude-code", event, "--delivery-trace")
					cmd.Env = append(os.Environ(), "MEX_HOME="+activeHome)
					cmd.Stdin = bytes.NewReader(body)
					var trace bytes.Buffer
					cmd.Stderr = &trace
					start := time.Now()
					out, err := cmd.Output()
					elapsed := time.Since(start)
					if err != nil || !json.Valid(out) {
						t.Fatal(err, string(out))
					}
					if strings.Contains(trace.String(), "delivery failed:") {
						t.Errorf("reference=%v session=%s %s", reference, session, trace.String())
					}
					if measured {
						prefix := "prompt/"
						if reference {
							prefix = "reference/"
						}
						for _, line := range strings.Split(trace.String(), "\n") {
							fields := strings.Fields(line)
							if len(fields) == 4 && fields[0] == "delivery" && fields[1] == "phase" {
								ns, err := strconv.ParseInt(fields[3], 10, 64)
								if err == nil {
									key := prefix + fields[2]
									phases[key] = append(phases[key], time.Duration(ns))
								}
							}
						}
					}
					return elapsed, bytes.Contains(out, []byte("additionalContext"))
				}
				referenceBinary, referenceHome := base, baseHome
				if mode == "deliver" {
					referenceBinary, referenceHome = shim, home
				}
				for i := 0; i < 5; i++ {
					invoke(referenceBinary, referenceHome, fmt.Sprint("ref-warm", i), true, false)
					invoke(shim, home, fmt.Sprint("prompt-warm", i), false, false)
				}
				var baseline, current, delta []time.Duration
				sent, refSent := 0, 0
				for i := 0; i < 100; i++ {
					var a, b time.Duration
					var delivered, refDelivered bool
					if i%2 == 0 {
						a, refDelivered = invoke(referenceBinary, referenceHome, fmt.Sprint("ref", i), true, true)
						b, delivered = invoke(shim, home, fmt.Sprint("prompt", i), false, true)
					} else {
						b, delivered = invoke(shim, home, fmt.Sprint("prompt", i), false, true)
						a, refDelivered = invoke(referenceBinary, referenceHome, fmt.Sprint("ref", i), true, true)
					}
					if delivered {
						sent++
					}
					if refDelivered {
						refSent++
					}
					baseline = append(baseline, a)
					current = append(current, b)
					delta = append(delta, b-a)
				}
				a, b, d := summarize(baseline), summarize(current), summarize(delta)
				t.Logf("prompt entries=%d mode=%s runs=100 reference=%s/%s current=%s/%s paired delta=%s/%s ms; delivered=%d referenceDelivered=%d", count, mode, ms(a.p50), ms(a.p95), ms(b.p50), ms(b.p95), ms(d.p50), ms(d.p95), sent, refSent)
				for name, samples := range phases {
					s := summarize(samples)
					t.Logf("mode=%s phase=%s runs=%d p50=%s p95=%s ms", mode, name, len(samples), ms(s.p50), ms(s.p95))
				}
				want := 0
				if mode == "deliver" {
					want = 100
				}
				if sent != want || refSent != want {
					t.Errorf("unequal outcomes: current=%d reference=%d want=%d", sent, refSent, want)
				}
				if d.p95 > 15*time.Millisecond {
					t.Errorf("prompt overhead %s ms exceeds 15 ms p95", ms(d.p95))
				}
				if mode == "deliver" {
					db, err := sql.Open("sqlite", filepath.Join(home, ".mex", "hooks.db"))
					if err != nil {
						t.Fatal(err)
					}
					var receipts, low, high, total int
					err = db.QueryRow(`SELECT count(*),min(tokens),max(tokens),sum(tokens)
						FROM deliveries WHERE action='given' AND session_id LIKE 'deliverprompt%'`).Scan(&receipts, &low, &high, &total)
					db.Close()
					if err != nil {
						t.Fatal(err)
					}
					t.Logf("prompt entries=%d estimated receipt tokens count=%d min=%d max=%d total=%d", count, receipts, low, high, total)
				}
			}
		})
	}
}
