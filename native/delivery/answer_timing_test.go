package delivery

import (
	"github.com/mex-memory/mex/native/internal/contract"
	"os"
	"runtime"
	"sort"
	"testing"
	"time"
)

// Linux enforces the core hook budget. Windows cold-process pairs are measured
// by scripts/delivery-replay/answer-timing.mjs against an archived base binary.
func TestAnswerPathTiming(t *testing.T) {
	if os.Getenv("MEX_ANSWER_TIMING") != "1" {
		t.Skip("opt-in timing gate; run on the pinned runner")
	}
	for _, kind := range []string{"prompt", "span", "silent", "noop"} {
		t.Run(kind, func(t *testing.T) {
			f, _ := spanFixture(t)
			env := f.env()
			env.Surfaces = "on"
			var samples []time.Duration
			for i := 0; i < 35; i++ {
				f.session = time.Unix(int64(i), 0).UTC().Format(time.RFC3339)
				var ev contract.Event
				switch kind {
				case "prompt":
					ev = f.event(contract.Prompt)
					ev.Prompt = &contract.PromptIn{Text: "Fix makeWidget", Typed: true}
				case "span":
					ev = f.event(contract.PostToolBatch, grep("makeWidget", "src/pool.ts"))
				case "silent":
					ev = f.event(contract.PostToolBatch, grep("unrelated.*regex", "No matches found"))
				case "noop":
					ev = f.event(contract.PreTool, contract.Tool{Name: contract.ToolOther})
				}
				start := time.Now()
				_, err := Handle(ev, env)
				elapsed := time.Since(start)
				if err != nil {
					t.Fatal(err)
				}
				if i >= 5 {
					samples = append(samples, elapsed)
				}
			}
			sort.Slice(samples, func(i, j int) bool { return samples[i] < samples[j] })
			p95 := samples[len(samples)*95/100]
			t.Logf("%s n=%d p50=%s p95=%s", kind, len(samples), samples[len(samples)/2], p95)
			if runtime.GOOS != "windows" && p95 > 15*time.Millisecond {
				t.Fatalf("core hook p95 %s exceeds 15ms", p95)
			}
		})
	}
}
