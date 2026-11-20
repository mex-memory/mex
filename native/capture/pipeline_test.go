package capture

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/mex-memory/mex/native/internal/contract"
)

func code(n int) *int { return &n }

func exitText(p *int) string {
	if p == nil {
		return "unknown"
	}
	if *p == 0 {
		return "pass"
	}
	return "fail"
}

func testdata(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// `npm test 2>&1 | tail -30` exits 0 whatever the tests did: real node --test
// output, cut by tail, decides it.
func TestPipelineExitFromARealNodeTestRunThroughTail(t *testing.T) {
	fail, pass := testdata(t, "node-test-tail30-fail.txt"), testdata(t, "node-test-tail30-pass.txt")
	for _, c := range []struct{ out, want string }{{fail, "fail"}, {pass, "pass"}} {
		got, piped := PipelineExit("npm test 2>&1 | tail -30", c.out, code(0))
		if exitText(got) != c.want || !piped {
			t.Fatalf("want %s, got %s (piped %v)", c.want, exitText(got), piped)
		}
	}
}

func TestPipelineExitRunnerSummaries(t *testing.T) {
	cases := map[string]struct{ out, want string }{
		"npm error":           {"> app@1.0.0 test\n> jest\n\nnpm ERR! code ELIFECYCLE\nnpm ERR! errno 1\n", "fail"},
		"npm 10 error":        {"npm error Lifecycle script `test` failed with error:\nnpm error code 1\n", "fail"},
		"node TAP fail":       {"# tests 3\n# pass 2\n# fail 1\n", "fail"},
		"node TAP pass":       {"# tests 3\n# pass 3\n# fail 0\n", "pass"},
		"vitest fail":         {" Test Files  1 failed | 4 passed (5)\n      Tests  2 failed | 40 passed (42)\n", "fail"},
		"vitest pass":         {" Test Files  5 passed (5)\n      Tests  42 passed (42)\n", "pass"},
		"jest fail":           {"Test Suites: 1 failed, 3 passed, 4 total\nTests:       1 failed, 20 passed, 21 total\n", "fail"},
		"jest pass":           {"Test Suites: 4 passed, 4 total\nTests:       21 passed, 21 total\n", "pass"},
		"pytest fail":         {"FAILED tests/test_a.py::test_x\n==== 1 failed, 9 passed in 0.42s ====\n", "fail"},
		"pytest pass":         {"==== 10 passed in 0.40s ====\n", "pass"},
		"go test fail":        {"--- FAIL: TestX (0.00s)\nFAIL\nFAIL\texample.com/x\t0.01s\n", "fail"},
		"go test pass":        {"ok  \texample.com/x\t0.01s\nok  \texample.com/y\t(cached)\n", "pass"},
		"cargo fail":          {"test result: FAILED. 3 passed; 1 failed; 0 ignored\n", "fail"},
		"cargo pass":          {"test result: ok. 4 passed; 0 failed; 0 ignored\n", "pass"},
		"tsc":                 {"src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.\n", "fail"},
		"eslint":              {"/w/src/a.ts\n  3:7  error  'x' is unused\n\n✖ 1 problem (1 error, 0 warnings)\n", "fail"},
		"no summary":          {"some build log\nDone.\n", "unknown"},
		"the last one counts": {"ℹ fail 2\n\n> app@1.0.0 test:time\nℹ tests 1\nℹ pass 1\nℹ fail 0\n", "pass"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			if got, _ := PipelineExit("npm test 2>&1 | tail -30", c.out, code(0)); exitText(got) != c.want {
				t.Fatalf("want %s, got %s", c.want, exitText(got))
			}
		})
	}
}

func TestPipelineExitKeepsOrDropsTheShellsCode(t *testing.T) {
	cases := map[string]struct {
		command, want string
		piped         bool
	}{
		"not a pipeline":                {"npm test", "fail", false},
		"pipefail set":                  {"set -o pipefail; npm test | tail -30", "fail", false},
		"or-or is no pipe":              {"npm test || true", "fail", false},
		"a pipe inside quotes":          {`node -e "a | b"`, "fail", false},
		"a stage that isn't a filter":   {"npm test | xargs echo", "unknown", true},
		"PowerShell filter":             {"npm test 2>&1 | Select-Object -Last 30", "unknown", true},
		"an earlier pipeline, then cmd": {"npm test | tail -5; npm run lint", "fail", false},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			got, piped := PipelineExit(c.command, "plain output\n", code(1))
			if exitText(got) != c.want || piped != c.piped {
				t.Fatalf("want %s piped=%v, got %s piped=%v", c.want, c.piped, exitText(got), piped)
			}
		})
	}
}

// The journal row of a Claude Code pipeline that hid a failure is a failure,
// and a Codex pipeline gets no call id: its transcript code is tail's.
func TestJournalRowForAPipeline(t *testing.T) {
	fail := testdata(t, "node-test-tail30-fail.txt")
	tool := &contract.Tool{Name: contract.ToolShell, Input: contract.ToolInput{Command: "npm test 2>&1 | tail -30"}, Output: &contract.ToolOutput{Text: fail, OK: true}, UseID: "call_1"}
	row, ok := commandRow(contract.Event{Agent: "claude-code", Kind: contract.PostTool, Tool: tool}, tool)
	if !ok || row.ExitCode == nil || *row.ExitCode == 0 {
		t.Fatalf("claude-code row: %+v", row)
	}
	codex := &contract.Tool{Name: contract.ToolShell, Input: contract.ToolInput{Command: "npm test | xargs echo"}, Output: &contract.ToolOutput{Text: "x", OK: true}, UseID: "call_2"}
	row, _ = commandRow(contract.Event{Agent: "codex", Kind: contract.PostTool, Tool: codex}, codex)
	if row.ExitCode != nil || row.CallID != "" {
		t.Fatalf("codex pipeline row: %+v", row)
	}
}
