package output

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/internal/tokens"
)

var update = flag.Bool("update", false, "rewrite testdata/outputs-report.txt")

// mustKeep is the replay's own oracle, written independently of the trimmer:
// any line naming an error, warning, failure or assertion, or a file:line.
var mustKeep = regexp.MustCompile(`(?i)error|warn|fail|assert|\S\.\w+:\d+`)

type savedOutput struct {
	name, command, text string
}

func savedOutputs(t *testing.T) []savedOutput {
	t.Helper()
	files, err := filepath.Glob(filepath.Join("testdata", "outputs", "*.txt"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no saved outputs: %v", err)
	}
	var out []savedOutput
	for _, f := range files {
		text, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		cmd, err := os.ReadFile(strings.TrimSuffix(f, ".txt") + ".cmd")
		if err != nil {
			t.Fatal(err)
		}
		out = append(out, savedOutput{strings.TrimSuffix(filepath.Base(f), ".txt"), strings.TrimSpace(string(cmd)), string(text)})
	}
	return out
}

// Replay over saved outputs: not one error, warning or file:line line is
// dropped, the last lines survive, counts add up, and the exact cut is
// reported in testdata/outputs-report.txt (characters counted, tokens estimated at 2.3 bytes each).
func TestReplaySavedOutputs(t *testing.T) {
	var report strings.Builder
	report.WriteString("# Replay of saved outputs through the trimmer (go test ./output -run TestReplaySavedOutputs -update)\n")
	report.WriteString("# name | command | noisy | lines | chars | trimmed | kept lines | dropped lines | dropped chars (counted) | dropped tokens (estimated, bytes/2.3)\n")
	totalChars, totalDropped := 0, 0
	for _, s := range savedOutputs(t) {
		t.Run(s.name, func(t *testing.T) {
			res := Trim(s.text, Header{ExitCode: 0, Ref: "mex out 1"})
			lines := splitLines(s.text)
			if !res.Trimmed {
				if res.Text != s.text {
					t.Fatal("an untrimmed result changed the text")
				}
			} else {
				kept := res.Text
				if !strings.HasPrefix(kept, "[MEX: output trimmed to ") || !strings.Contains(strings.SplitN(kept, "\n", 2)[0], "full text: mex out 1") {
					t.Fatalf("header: %q", strings.SplitN(kept, "\n", 2)[0])
				}
				// Every must-keep line appears, in order.
				rest := kept
				for i, line := range lines {
					must := mustKeep.MatchString(line) || i >= len(lines)-TailLines
					if !must {
						continue
					}
					at := strings.Index(rest, line+"\n")
					if at < 0 {
						t.Fatalf("dropped line %d: %q", i+1, line)
					}
					rest = rest[at+len(line)+1:]
				}
				if res.KeptLines+res.DroppedLines != res.Lines {
					t.Fatalf("kept %d + dropped %d != %d", res.KeptLines, res.DroppedLines, res.Lines)
				}
				markers := regexp.MustCompile(`(?m)^\[… ([\d,]+) lines? dropped …\]$`).FindAllStringSubmatch(kept, -1)
				sum := 0
				for _, m := range markers {
					var n int
					fmt.Sscan(strings.ReplaceAll(m[1], ",", ""), &n)
					sum += n
				}
				if sum != res.DroppedLines {
					t.Fatalf("gap markers say %d, result says %d", sum, res.DroppedLines)
				}
				if float64(res.DroppedChars) < MinSaving*float64(len(s.text)) {
					t.Fatalf("trimmed but saved only %d of %d", res.DroppedChars, len(s.text))
				}
			}
			fmt.Fprintf(&report, "%s | %s | %v | %d | %d | %v | %d | %d | %d | %d\n", s.name, s.command, Noisy(s.command), res.Lines, len(s.text), res.Trimmed, res.KeptLines, res.DroppedLines, res.DroppedChars, res.DroppedTokens())
			totalChars += len(s.text)
			totalDropped += res.DroppedChars
		})
	}
	fmt.Fprintf(&report, "# total: %d of %d characters dropped (counted), about %d tokens (estimated)\n", totalDropped, totalChars, tokens.CodeBytes(totalDropped))
	golden := filepath.Join("testdata", "outputs-report.txt")
	if *update {
		if err := os.WriteFile(golden, []byte(report.String()), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatalf("%v (run with -update)", err)
	}
	if strings.ReplaceAll(string(want), "\r\n", "\n") != report.String() {
		t.Fatalf("outputs-report.txt is out of date (run with -update):\n%s", report.String())
	}
	t.Log("\n" + report.String())
}

func TestTrimKeepsEveryKindOfEvidence(t *testing.T) {
	var lines []string
	for i := 0; i < 400; i++ {
		lines = append(lines, fmt.Sprintf("  ✓ case %d passes", i))
	}
	evidence := []string{
		"TypeError: cannot read properties of undefined",
		"src/cart.ts:12:5 - something odd",
		"  File \"orders/models.py\", line 51, in save",
		"    at Object.<anonymous> (/repo/test/a.test.js:4:11)",
		"npm WARN deprecated left-pad@1.0.0",
		"assertEquals(expected, actual) did not hold",
		"Tests:       400 passed, 400 total",
		"Program.cs(12,7): note CS0168",
	}
	for i, e := range evidence {
		lines[40+i*30] = e
	}
	text := strings.Join(lines, "\n") + "\n"
	res := Trim(text, Header{Ref: "mex out 3"})
	if !res.Trimmed {
		t.Fatal("not trimmed")
	}
	for _, e := range evidence {
		if !strings.Contains(res.Text, e+"\n") {
			t.Errorf("dropped %q", e)
		}
	}
	// The first error block: the line before it and the lines after it.
	if !strings.Contains(res.Text, lines[39]+"\n"+lines[40]+"\n"+lines[41]+"\n") {
		t.Error("first error block not kept whole")
	}
	if !strings.HasSuffix(res.Text, strings.Join(lines[len(lines)-TailLines:], "\n")+"\n") {
		t.Error("last lines not kept")
	}
}

func TestTrimLeavesShortOrDenseOutputWhole(t *testing.T) {
	short := strings.Repeat("x\n", 100)
	if res := Trim(short, Header{}); res.Trimmed || res.Text != short {
		t.Fatal("short output trimmed")
	}
	// Every line matters: nothing worth cutting.
	dense := strings.Repeat("src/a.ts:1:1 error here\n", 1000)
	if res := Trim(dense, Header{}); res.Trimmed || res.Text != dense {
		t.Fatal("dense output trimmed")
	}
}

func TestNoisy(t *testing.T) {
	yes := []string{
		"npm test", "npm run test:unit", "pnpm build", "yarn lint", "npx vitest run", "go test ./...", "cargo build --release",
		"python -m pytest -q", "uv run pytest", "FOO=1 make", "git log --oneline", "git -C repo log", "rg -n foo", "find . -name '*.ts'",
		"npm ci", "pip install -r requirements.txt", "./gradlew build", "dotnet test", "eslint src", "tsc --noEmit", "cd web && npm test",
	}
	no := []string{
		"cat package.json", "git diff", "git show HEAD", "npm test | tail -20", "sed -n 1,200p src/a.ts", "ls -la", "echo hi",
		"MEX_RAW=1 npm test", "mex out 3", "git status", "python -c 'print(1)'", "head -n 50 log.txt", "node script.js",
		"Get-Content big.log", "npm test 2>&1 | head -100",
	}
	for _, c := range yes {
		if !Noisy(c) {
			t.Errorf("Noisy(%q) = false", c)
		}
	}
	for _, c := range no {
		if Noisy(c) {
			t.Errorf("Noisy(%q) = true", c)
		}
	}
}

func TestCalibratedDroppedTokens(t *testing.T) {
	if got := (Result{DroppedChars: 230}).DroppedTokens(); got != 100 {
		t.Fatalf("got %d", got)
	}
}
