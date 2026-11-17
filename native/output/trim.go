// Package output makes long command output smaller without hiding evidence
// (plan sheet 35, L3 and L4): a successful noisy command's output keeps its
// exit code, its first error block, every error, warning, failure, assertion
// and path:line line, its test summaries and its last lines; the rest is
// counted, and the full text is saved so `mex out <n>` can show it.
//
// Nothing here runs at hook start-up: patterns compile on first use.
package output

import (
	"fmt"
	"regexp"
	"strings"
	"sync"
)

// Parameters start at the plan's values (sheet 35, L3).
const (
	// MinChars is the smallest output that is trimmed at all.
	MinChars = 8000
	// TailLines are always kept from the end.
	TailLines = 30
	// HeadLines are kept from the start, so the reader sees how it began.
	HeadLines = 5
	// ErrorBlockLines caps the first error block after its first line.
	ErrorBlockLines = 20
	// MinSaving: a trim that cuts less than this share of the characters is
	// not worth a refetch, so the output is left whole.
	MinSaving = 0.25
)

func lazy(expr string) func() *regexp.Regexp {
	return sync.OnceValue(func() *regexp.Regexp { return regexp.MustCompile(expr) })
}

// Error lines are matched on lowercase substrings (errorWords below:
// TypeError, assertEquals, ERR!), so they keep more than they must rather
// than less.

// hardError: the error lines that start the first error block (not warnings).
var hardError = lazy(`(?i)(error|\bfail(ed|ure|ing)?\b|assert|panic|exception|traceback|fatal|[✗✘×✖]|^\s*●\s)`)

// locationLine: path:line, path(line,col) as some compilers print it,
// Python's `File "x.py", line 3`, and stack frames ending in :line:col.
var locationLine = lazy(`\S\.\w+:\d+|\S\.\w+\(\d+(,\d+)?\)|File "[^"]+", line \d+|:\d+:\d+\)?\s*$`)

// summaryLine: test and build summaries.
var summaryLine = lazy(`(?i)(^\s*(tests?|test files|test suites|suites|snapshots|time|duration|start at)(:|\s{2,})\s*\S|^\s*ran (all|\d+)\b|\b\d+\s+(passed|failed|passing|failing|pending|skipped|todo|errors?|warnings?|tests?)\b|^\s*(ok|fail|pass|failed|passed)\b|test result:|^=+ .+ =+$|^(ok|FAILED)\s*(\(|$)|\bbuild (succeeded|failed)\b|\bcompiled\b.*\b(successfully|with)\b|\bfinished\b.*\bin\b|\bdone in\b|^added \d+ packages?|^up to date|\baudited \d+ packages?|\bfound \d+ vulnerabilit)`)

// Kind says why a line was kept.
type Kind int

const (
	keptNo Kind = iota
	KeptHead
	KeptTail
	KeptErrorBlock
	KeptError
	KeptLocation
	KeptSummary
)

// Result is a trimmed output and what was cut.
type Result struct {
	Text string // the trimmed text, with gap markers; equal to the input when Trimmed is false
	// Trimmed is false when the output was short, or trimming saved too little.
	Trimmed       bool
	Lines         int // lines in the input
	KeptLines     int
	DroppedLines  int
	DroppedChars  int // characters (bytes) of the dropped lines, newlines included
	OriginalChars int
}

// DroppedTokens is an estimate: characters / 4, the rule the file index uses.
func (r Result) DroppedTokens() int { return (r.DroppedChars + 3) / 4 }

// Important reports whether a line must survive any trim: an error, warning,
// failure or assertion, a path:line location, or a test summary.
func Important(line string) bool {
	return classify(line) != keptNo
}

func classify(line string) Kind {
	if strings.TrimSpace(line) == "" {
		return keptNo
	}
	// Cheap checks first: most lines of a long output match nothing, and a
	// regular expression per line is what the hook would pay for.
	lower := strings.ToLower(line)
	if containsAny(lower, errorWords) || strings.HasPrefix(strings.TrimSpace(line), "●") {
		return KeptError
	}
	if mayLocate(line) && locationLine().MatchString(line) {
		return KeptLocation
	}
	if containsAny(lower, summaryWords) && summaryLine().MatchString(line) {
		return KeptSummary
	}
	return keptNo
}

// errorWords is errorLine as substrings (lowercase).
var errorWords = []string{"error", "warn", "fail", "assert", "panic", "exception", "traceback", "fatal", "denied", "unhandled", "✗", "✘", "×", "✖"}

// summaryWords: a line can only be a summary if it holds one of these.
var summaryWords = []string{"test", "suite", "snapshot", "time", "duration", "start at", "ran ", "pass", "fail", "ok", "skip", "pending", "todo", "error", "warning", "result", "==", "build", "compiled", "finished", "done in", "added", "up to date", "audited", "vulnerab"}

func containsAny(s string, words []string) bool {
	for _, w := range words {
		if strings.Contains(s, w) {
			return true
		}
	}
	return false
}

// mayLocate: a location needs ":<digit>", "(<digit>" or `", line `.
func mayLocate(line string) bool {
	for i := 0; i+1 < len(line); i++ {
		if (line[i] == ':' || line[i] == '(') && line[i+1] >= '0' && line[i+1] <= '9' {
			return true
		}
	}
	return strings.Contains(line, `", line `)
}

// Header is what the model sees first when output is trimmed. ref names the
// saved full text (for example "mex out 7").
type Header struct {
	ExitCode int
	Ref      string
}

// Trim keeps what matters from text. It never drops an important line; when
// the result would not be at least MinSaving smaller, it returns text whole.
func Trim(text string, h Header) Result {
	res := Result{Text: text, OriginalChars: len(text)}
	lines := splitLines(text)
	res.Lines = len(lines)
	if len(text) <= MinChars {
		res.KeptLines = len(lines)
		return res
	}
	keep := make([]Kind, len(lines))
	for i := 0; i < len(lines) && i < HeadLines; i++ {
		keep[i] = KeptHead
	}
	for i := max(0, len(lines)-TailLines); i < len(lines); i++ {
		keep[i] = KeptTail
	}
	firstBlock := -1
	for i, line := range lines {
		k := classify(line)
		if k == keptNo {
			continue
		}
		if keep[i] == keptNo {
			keep[i] = k
		}
		if firstBlock < 0 && k == KeptError && hardError().MatchString(line) {
			firstBlock = i
		}
	}
	if firstBlock >= 0 {
		// The first error block: the line before it (often the test or file
		// name), the error, and what follows until a blank line.
		if firstBlock > 0 && keep[firstBlock-1] == keptNo {
			keep[firstBlock-1] = KeptErrorBlock
		}
		for i := firstBlock + 1; i < len(lines) && i <= firstBlock+ErrorBlockLines; i++ {
			if strings.TrimSpace(lines[i]) == "" {
				break
			}
			if keep[i] == keptNo {
				keep[i] = KeptErrorBlock
			}
		}
	}

	var b strings.Builder
	gap, gapChars := 0, 0
	flush := func() {
		if gap > 0 {
			fmt.Fprintf(&b, "[… %s dropped …]\n", plural(gap, "line"))
			res.DroppedLines += gap
			res.DroppedChars += gapChars
			gap, gapChars = 0, 0
		}
	}
	for i, line := range lines {
		size := len(line)
		if i < len(lines)-1 || strings.HasSuffix(text, "\n") {
			size++
		}
		if keep[i] == keptNo {
			gap++
			gapChars += size
			continue
		}
		flush()
		b.WriteString(line)
		b.WriteByte('\n')
		res.KeptLines++
	}
	flush()
	if res.DroppedLines == 0 || float64(res.DroppedChars) < MinSaving*float64(len(text)) {
		return Result{Text: text, OriginalChars: len(text), Lines: len(lines), KeptLines: len(lines)}
	}
	ref := h.Ref
	if ref == "" {
		ref = "not saved"
	}
	head := fmt.Sprintf("[MEX: output trimmed to %s of %s (exit %d) · dropped %s, %s characters · full text: %s]\n",
		group(res.KeptLines), plural(res.Lines, "line"), h.ExitCode, plural(res.DroppedLines, "line"), group(res.DroppedChars), ref)
	res.Text = head + b.String()
	res.Trimmed = true
	return res
}

// splitLines splits on \n; a trailing newline does not make an empty line.
// Carriage returns stay on their line, so kept text is byte-exact.
func splitLines(text string) []string {
	if text == "" {
		return nil
	}
	lines := strings.Split(text, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

func plural(n int, noun string) string {
	if n == 1 {
		return "1 " + noun
	}
	return group(n) + " " + noun + "s"
}

// group writes 12345 as 12,345.
func group(n int) string {
	s := fmt.Sprint(n)
	if n < 0 {
		return "-" + group(-n)
	}
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}

// refPlaceholder stands in for the saved output's name until it is saved.
const refPlaceholder = "\x00mex-out-ref\x00"

// TrimAndSave trims text once and, only when that cuts something, saves the
// full text with save and names it in the header. When nothing is cut or the
// save fails, it returns text whole and false.
func TrimAndSave(text string, exitCode int, save func() (int, error)) (string, bool) {
	res := Trim(text, Header{ExitCode: exitCode, Ref: refPlaceholder})
	if !res.Trimmed {
		return text, false
	}
	n, err := save()
	if err != nil {
		return text, false
	}
	return strings.Replace(res.Text, refPlaceholder, Ref(n), 1), true
}
