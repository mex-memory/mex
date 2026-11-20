package capture

import (
	"regexp"
	"strconv"
	"strings"
	"sync"
)

// A pipeline's exit status is its last stage's: `npm test 2>&1 | tail -30`
// exits 0 when the tests fail. The journal must not record that as a pass.
// When every stage after the first only passes text through, the runner's
// own summary at the end of the output says how the command ended; anything
// else is unknown. `set -o pipefail` in the command makes the code trustworthy.

// summaryBytes bounds the output read for a runner summary.
const summaryBytes = 8 << 10

var passThrough = map[string]bool{
	"tail": true, "head": true, "grep": true, "egrep": true, "fgrep": true, "cat": true, "tee": true, "less": true, "more": true,
	"sort": true, "uniq": true, "wc": true, "select-object": true, "select": true, "select-string": true, "sls": true,
	"out-string": true, "ft": true, "fl": true,
}

// lastPipeline returns the stages of the command's last list element (split
// at ;, &&, || and newlines, outside quotes).
func lastPipeline(command string) (stages []string) {
	var quote byte
	escaped := false
	stageStart := 0
	for i := 0; i < len(command); i++ {
		c := command[i]
		if escaped {
			escaped = false
			continue
		}
		if c == '\\' && quote != '\'' {
			escaped = true
			continue
		}
		if quote != 0 {
			if c == quote {
				quote = 0
			}
			continue
		}
		switch {
		case c == '\'' || c == '"':
			quote = c
		case c == ';' || c == '\n':
			stages, stageStart = nil, i+1
		case (c == '&' || c == '|') && i+1 < len(command) && command[i+1] == c:
			stages, stageStart = nil, i+2
			i++
		case c == '|':
			stages = append(stages, strings.TrimSpace(command[stageStart:i]))
			stageStart = i + 1
			if i+1 < len(command) && command[i+1] == '&' { // bash `|&`
				stageStart, i = i+2, i+1
			}
		}
	}
	return append(stages, strings.TrimSpace(command[stageStart:]))
}

var pipefailRE = sync.OnceValue(func() *regexp.Regexp {
	return regexp.MustCompile(`\bset\s+(?:-[a-zA-Z]*o\s+|-o\s+)pipefail\b|\bpipefail\b`)
})

// PipelineExit corrects a shell command's reported exit code for a pipeline:
// piped is true when the code came from the output's runner summary (or is
// unknown) rather than from the shell.
func PipelineExit(command, output string, code *int) (exit *int, piped bool) {
	stages := lastPipeline(command)
	if len(stages) < 2 || pipefailRE().MatchString(command) {
		return code, false
	}
	for _, s := range stages[1:] {
		f := strings.Fields(s)
		if len(f) == 0 {
			return nil, true
		}
		name := strings.TrimSuffix(strings.ToLower(f[0]), ".exe")
		if !passThrough[name] && !strings.HasPrefix(name, "format-") {
			return nil, true
		}
	}
	return runnerSummary(output), true
}

type summary struct {
	re      *regexp.Regexp
	verdict func(m []string) (failed, known bool)
}

func always(failed bool) func([]string) (bool, bool) {
	return func([]string) (bool, bool) { return failed, true }
}

// summaries are anchored lines that known runners print last.
var summaries = sync.OnceValue(func() []summary {
	return []summary{
		// npm: a failing script prints `npm ERR!` (npm 6-9) or `npm error` (npm 10+), ELIFECYCLE included.
		{regexp.MustCompile(`(?m)^npm (?:ERR!|error) `), always(true)},
		// node --test's spec reporter lists failed tests (`✖ name (4ms)`) after its
		// summary, so that list is often all `| tail` keeps of a failing run.
		{regexp.MustCompile(`(?m)^✖ failing tests:\s*$`), always(true)},
		{regexp.MustCompile(`(?m)^\s*✖ .+ \(\d[\d.]*m?s\)\s*$`), always(true)},
		// node --test: TAP `# fail N`, spec `ℹ fail N`.
		{regexp.MustCompile(`(?m)^(?:#|ℹ) fail (\d+)\s*$`), func(m []string) (bool, bool) { n, err := strconv.Atoi(m[1]); return n > 0, err == nil }},
		// vitest `Test Files  1 failed | 2 passed`, `Tests  3 passed`; jest `Tests:       1 failed, 2 passed, 3 total`.
		{regexp.MustCompile(`(?m)^\s*(?:Test Files|Test Suites|Tests):?\s+(\d+ (?:failed|passed|skipped|todo)[^\n]*)$`), func(m []string) (bool, bool) {
			return strings.Contains(m[1], "failed"), strings.Contains(m[1], "failed") || strings.Contains(m[1], "passed")
		}},
		// pytest: `==== 1 failed, 2 passed in 0.12s ====`.
		{regexp.MustCompile(`(?m)^=+ ([^=\n]*\bin [\d.]+s[^=\n]*) =+\s*$`), func(m []string) (bool, bool) {
			failed := strings.Contains(m[1], " failed") || strings.Contains(m[1], " error")
			return failed, failed || strings.Contains(m[1], " passed")
		}},
		// go test.
		{regexp.MustCompile(`(?m)^(?:FAIL|--- FAIL:)[\s]`), always(true)},
		{regexp.MustCompile(`(?m)^FAIL$`), always(true)},
		{regexp.MustCompile(`(?m)^ok\s+\S+\s+(?:[\d.]+s|\(cached\))`), always(false)},
		// cargo test.
		{regexp.MustCompile(`(?m)^test result: (ok|FAILED)\.`), func(m []string) (bool, bool) { return m[1] == "FAILED", true }},
		// tsc and eslint.
		{regexp.MustCompile(`(?m)error TS\d+:`), always(true)},
		{regexp.MustCompile(`(?m)^✖ \d+ problems?\b`), always(true)},
	}
})

// runnerSummary reads the last summary line a known runner printed: the last
// one wins, so `a | tail; b | tail` is judged by b. None found: unknown.
func runnerSummary(output string) *int {
	if len(output) > summaryBytes {
		output = output[len(output)-summaryBytes:]
	}
	best, verdict := -1, false
	for _, s := range summaries() {
		for _, idx := range s.re.FindAllStringSubmatchIndex(output, -1) {
			if idx[0] < best {
				continue
			}
			m := make([]string, len(idx)/2)
			for k := range m {
				if idx[2*k] >= 0 {
					m[k] = output[idx[2*k]:idx[2*k+1]]
				}
			}
			if failed, known := s.verdict(m); known {
				best, verdict = idx[0], failed
			}
		}
	}
	if best < 0 {
		return nil
	}
	code := 0
	if verdict {
		code = 1
	}
	return &code
}
