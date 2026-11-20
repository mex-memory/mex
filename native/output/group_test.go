package output

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

// Expansion is deliberately independent of the grouping parser.
func expandGrouped(text, kind string) string {
	_, body, _ := strings.Cut(text, "\n")
	lines := strings.Split(body, "\n")
	var out strings.Builder
	path := ""
	for i, line := range lines {
		if i == len(lines)-1 && line == "" {
			break
		}
		if line == "--" || line == "--\r" {
			out.WriteString(line)
			if i < len(lines)-1 {
				out.WriteByte('\n')
			}
			continue
		}
		if !strings.HasPrefix(line, "  ") {
			path = line
			continue
		}
		hit := strings.TrimPrefix(line, "  ")
		if kind != "listing" || path != "." {
			out.WriteString(path)
		}
		if kind == "listing" {
			out.WriteString(hit)
		} else if strings.HasPrefix(hit, "-") {
			before, after, _ := strings.Cut(hit[1:], "- ")
			out.WriteString("-" + before + "-" + after)
		} else {
			before, after, _ := strings.Cut(hit, ": ")
			out.WriteString(":" + before)
			if before != "" {
				out.WriteByte(':')
			}
			out.WriteString(after)
		}
		if i < len(lines)-1 {
			out.WriteByte('\n')
		}
	}
	return out.String()
}
func TestGroupingReplayLossless(t *testing.T) {
	grouped := 0
	for _, s := range savedOutputs(t) {
		kind := groupKind(s.command)
		if kind != "search" && kind != "listing" {
			continue
		}
		t.Run(s.name, func(t *testing.T) {
			result, ok := Group(s.text, kind, "mex out 7")
			t.Log(s.name, kind, ok)
			if !ok {
				if result != s.text {
					t.Fatal("changed whole output")
				}
				return
			}
			grouped++
			if got := expandGrouped(result, kind); got != s.text {
				t.Fatalf("expansion mismatch: %.120q vs %.120q", got, s.text)
			}
			if !strings.Contains(result, "nothing dropped") || !strings.Contains(result, "mex out 7") {
				t.Fatal("missing header")
			}
			if float64(len(result)) > (1-MinSaving)*float64(len(s.text)) {
				t.Fatal("insufficient saving")
			}
		})
	}
	if grouped < 5 {
		t.Fatalf("only %d fixture kinds grouped", grouped)
	}
}
func TestGroupingAbstainsAndSaves(t *testing.T) {
	for _, cmd := range []string{"rg x", "grep -rn x .", "git grep x", "ag x", "ack x", "Select-String x", "find .", "fd .", "git ls-files", "Get-ChildItem -Name", "tree", "rg x | sort", "find . | sort"} {
		full := strings.Repeat("cannot parse this output\n", 600)
		got, ok := PresentAndSave(cmd, full, 0, func() (int, error) { t.Fatal("saved unparsed output"); return 0, nil })
		if ok || got != full {
			t.Fatal(cmd)
		}
	}
	full := strings.Repeat("src/very/long/path/to/a/file.ts:12:needle\n", 500)
	for _, tail := range []string{"\n", ""} {
		text := strings.TrimSuffix(full, "\n") + tail
		got, ok := PresentAndSave("rg -n x", text, 0, func() (int, error) { return 7, nil })
		if !ok || expandGrouped(got, "search") != text {
			t.Fatal("newline or save reference")
		}
		got, ok = PresentAndSave("rg -n x", text, 0, func() (int, error) { return 0, errors.New("no storage") })
		if ok || got != text {
			t.Fatal("save failure changed output")
		}
	}
	for _, line := range []string{"C:\\x\\y.ts:12:text", "path:with:colon.ts:12:text", "x.ts-12-context", "file.ts:text"} {
		if _, ok := searchLine(line); !ok {
			t.Fatal(line)
		}
	}
	for _, line := range []string{"oops", "a:b:c", "a:12:b:13:c"} {
		if _, ok := searchLine(line); ok {
			t.Fatal(fmt.Sprint("ambiguous ", line))
		}
	}
}

func TestListingRootAndCRLF(t *testing.T) {
	text := strings.Repeat("src/a/very/long/directory/name/file.ts\r\n", 400) + "root.ts\r\n"
	got, ok := Group(text, "listing", "mex out 1")
	if !ok || expandGrouped(got, "listing") != text {
		t.Fatal("root listing did not round trip")
	}
}
