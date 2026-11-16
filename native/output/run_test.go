package output

import (
	"bytes"
	"errors"
	"fmt"
	"runtime"
	"strings"
	"testing"
)

// testShell runs the wrapper's own tests through a shell every CI machine has.
func testShell() string {
	if runtime.GOOS == "windows" {
		return ShellPowerShell
	}
	return ShellSh
}

func longCommand() string {
	// Prints 600 passing lines, one warning and a summary: noisy (a find)
	// and over the trim threshold.
	if runtime.GOOS == "windows" {
		return `Get-ChildItem -Path . -Filter no-such-mex-file; 1..600 | ForEach-Object { " - case $_ passes" }; "warning: slow test src/a.test.ts:12"; "Tests: 600 passed"`
	}
	return `find /nonexistent-mex-dir 2>/dev/null; i=0; while [ $i -lt 600 ]; do echo " - case $i passes"; i=$((i+1)); done; echo "warning: slow test src/a.test.ts:12"; echo "Tests: 600 passed"`
}

func TestRunKeepsExitCodeAndPrintsTheCommandFirst(t *testing.T) {
	for _, code := range []int{0, 1, 3, 42} {
		var out, errOut bytes.Buffer
		cmd := fmt.Sprintf("echo hello; exit %d", code)
		got := Run(RunOptions{Shell: testShell(), Command: cmd, Stdout: &out, Stderr: &errOut})
		if got != code {
			t.Fatalf("exit %d, want %d (%s)", got, code, errOut.String())
		}
		if !strings.HasPrefix(out.String(), "$ "+cmd+"\n") || !strings.Contains(out.String(), "hello") {
			t.Fatalf("output %q", out.String())
		}
	}
}

func TestRunPassesStdinAndStderr(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX shell syntax")
	}
	var out bytes.Buffer
	code := Run(RunOptions{Shell: ShellSh, Command: "read x; echo got $x; echo oops >&2", Stdin: strings.NewReader("input\n"), Stdout: &out, Stderr: &out})
	if code != 0 || !strings.Contains(out.String(), "got input") || !strings.Contains(out.String(), "oops") {
		t.Fatalf("%d %q", code, out.String())
	}
}

func TestRunTrimsOnlyWhatIsSaved(t *testing.T) {
	saved := ""
	save := func(text string, code int) (int, error) { saved = text; return 9, nil }
	var out bytes.Buffer
	if code := Run(RunOptions{Shell: testShell(), Command: longCommand(), Stdout: &out, Stderr: &out, Save: save}); code != 0 {
		t.Fatalf("exit %d: %s", code, out.String())
	}
	text := out.String()
	if !strings.Contains(text, "[MEX: output trimmed") || !strings.Contains(text, "full text: mex out 9") || !strings.Contains(text, "warning: slow test src/a.test.ts:12") || !strings.Contains(text, "Tests: 600 passed") {
		t.Fatalf("not trimmed with its evidence:\n%.2000s", text)
	}
	if !strings.Contains(saved, " - case 300 passes") || strings.Contains(text, " - case 300 passes") {
		t.Fatal("the full text was not saved, or the trim kept everything")
	}

	// Not saved, raw, or failed: the whole output.
	for name, o := range map[string]RunOptions{
		"save failed": {Save: func(string, int) (int, error) { return 0, errors.New("read-only") }},
		"raw":         {Raw: true, Save: save},
		"no save":     {},
	} {
		var whole bytes.Buffer
		o.Shell, o.Command, o.Stdout, o.Stderr = testShell(), longCommand(), &whole, &whole
		Run(o)
		if strings.Contains(whole.String(), "[MEX:") || !strings.Contains(whole.String(), " - case 300 passes") {
			t.Fatalf("%s: trimmed", name)
		}
	}
	failing := longCommand() + "; exit 1"
	var whole bytes.Buffer
	if code := Run(RunOptions{Shell: testShell(), Command: failing, Stdout: &whole, Stderr: &whole, Save: save}); code != 1 || strings.Contains(whole.String(), "[MEX:") {
		t.Fatalf("a failure was trimmed or lost its code %d", code)
	}
}

func TestRunMissingShell(t *testing.T) {
	var out, errOut bytes.Buffer
	if code := Run(RunOptions{Shell: "fish", Command: "true", Stdout: &out, Stderr: &errOut}); code != 127 || errOut.Len() == 0 {
		t.Fatalf("%d %q", code, errOut.String())
	}
}

func TestEncodePowerShell(t *testing.T) {
	// "a'é" in UTF-16LE.
	if got := EncodePowerShell("a'é"); got != "YQAnAOkA" {
		t.Fatal(got)
	}
}
