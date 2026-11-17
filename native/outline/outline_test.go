package outline

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/index/shift"
	"github.com/mex-memory/mex/native/outline/outlinetest"
)

func termsOf(prompt string) map[uint64]bool {
	terms := map[uint64]bool{}
	for _, w := range identifiers(prompt) {
		if len(w) >= 3 {
			terms[WordHash(w)] = true
		}
	}
	return terms
}

var (
	headerRe = regexp.MustCompile(`^\[MEX: ([\d,]+)-line file shown as outline( \+ lines (\d+–\d+(, \d+–\d+)*))? · full text: Read offset=1 limit=(\d+)\]$`)
	entryRe  = regexp.MustCompile(`^(\d+)-(\d+) +( *)(\w+) (.+)$`)
	sliceRe  = regexp.MustCompile(`^Lines (\d+)–(\d+):$`)
	lineRe   = regexp.MustCompile(`^ *(\d+)  (.*)$`)
)

// Replay over saved reads: every outline is valid in shape. The header names
// the real line count and the full-text read, every entry is a real symbol
// with its real span, and every slice line is the file's own line.
func TestReplaySavedReads(t *testing.T) {
	reads, err := outlinetest.SavedReads()
	if err != nil {
		t.Fatal(err)
	}
	for _, r := range reads {
		t.Run(r.Name, func(t *testing.T) {
			res, ok := Render(Input{Path: r.Name, Content: r.Content, Symbols: r.Symbols, Terms: termsOf(r.Prompt)})
			if !ok {
				t.Fatal("not outlined")
			}
			lines := splitLines(r.Content)
			out := strings.Split(strings.TrimSuffix(res.Text, "\n"), "\n")
			m := headerRe.FindStringSubmatch(out[0])
			if m == nil {
				t.Fatalf("header %q", out[0])
			}
			if n, _ := strconv.Atoi(strings.ReplaceAll(m[1], ",", "")); n != len(lines) || m[5] != strconv.Itoa(len(lines)) {
				t.Fatalf("header line count %q, file has %d", out[0], len(lines))
			}
			spans := map[string]bool{}
			for _, s := range r.Symbols {
				spans[fmt.Sprintf("%d-%d %s %s", s.Start, s.End, s.Kind, s.Name)] = true
			}
			entries, inSlice, sliceFrom, sliceTo, sliceSeen := 0, false, 0, 0, 0
			var slices []string
			for _, line := range out[2:] {
				switch {
				case line == "":
					continue
				case sliceRe.MatchString(line):
					if inSlice && sliceSeen != sliceTo-sliceFrom+1 {
						t.Fatalf("slice %d–%d showed %d lines", sliceFrom, sliceTo, sliceSeen)
					}
					sm := sliceRe.FindStringSubmatch(line)
					sliceFrom, _ = strconv.Atoi(sm[1])
					sliceTo, _ = strconv.Atoi(sm[2])
					inSlice, sliceSeen = true, 0
					slices = append(slices, sm[1]+"–"+sm[2])
				case inSlice:
					lm := lineRe.FindStringSubmatch(line)
					if lm == nil {
						t.Fatalf("slice line %q", line)
					}
					n, _ := strconv.Atoi(lm[1])
					if n != sliceFrom+sliceSeen || strings.TrimSuffix(lines[n-1], "\r") != lm[2] {
						t.Fatalf("slice line %d is not the file's: %q", n, line)
					}
					sliceSeen++
				case strings.HasPrefix(line, "("):
					continue
				default:
					em := entryRe.FindStringSubmatch(line)
					if em == nil || !spans[fmt.Sprintf("%s-%s %s %s", em[1], em[2], em[4], em[5])] {
						t.Fatalf("entry %q is not a symbol of the file", line)
					}
					entries++
				}
			}
			if inSlice && sliceSeen != sliceTo-sliceFrom+1 {
				t.Fatalf("last slice showed %d lines", sliceSeen)
			}
			if got := strings.Join(slices, ", "); m[3] != got {
				t.Fatalf("header names slices %q, outline shows %q", m[3], got)
			}
			if entries == 0 || len(res.Text) > int(MaxShare*float64(len(r.Content))) {
				t.Fatalf("%d entries, %d of %d characters", entries, len(res.Text), len(r.Content))
			}
			if r.Prompt != "" && len(res.Slices) == 0 {
				t.Errorf("prompt %q named nothing in the file", r.Prompt)
			}
			t.Logf("%s: %d lines, %d → %d characters (counted), %d slices", r.Name, len(lines), len(r.Content), len(res.Text), len(res.Slices))
		})
	}
}

func TestRenderDeclines(t *testing.T) {
	symbols := []shift.Symbol{{Name: "a", Kind: "function", Start: 1, End: 2}}
	if _, ok := Render(Input{Content: strings.Repeat("x\n", 100), Symbols: symbols}); ok {
		t.Error("outlined a small file")
	}
	if _, ok := Render(Input{Content: strings.Repeat("some code here\n", 3000)}); ok {
		t.Error("outlined a file with no symbols")
	}
	// Long names on short lines: the outline is nearly as big as the file.
	var many []shift.Symbol
	for i := 1; i <= 300; i++ {
		many = append(many, shift.Symbol{Name: fmt.Sprintf("%s_%d", strings.Repeat("very_long_constant_name", 4), i), Kind: "const", Start: i, End: i})
	}
	if _, ok := Render(Input{Content: strings.Repeat("const x = 1;\n", 3000), Symbols: many}); ok {
		t.Error("outlined when the outline is not much smaller")
	}
}
