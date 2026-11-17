package shift

import (
	"encoding/json"
	"path"
	"regexp"
	"sort"
	"strings"
	"sync"
)

// LangOf is the index's language for a path, as langOf in classify.ts.
func LangOf(file string) string {
	base := path.Base(strings.ReplaceAll(file, `\`, "/"))
	dot := strings.LastIndexByte(base, '.')
	if dot <= 0 {
		return "other"
	}
	switch strings.ToLower(base[dot:]) {
	case ".ts", ".mts", ".cts":
		return "ts"
	case ".tsx":
		return "tsx"
	case ".js", ".mjs", ".cjs", ".jsx":
		return "js"
	case ".py", ".pyi":
		return "py"
	case ".rs":
		return "rs"
	case ".cs":
		return "cs"
	}
	return "other"
}

// Compiled on first use: the hook starts on every agent call, and package
// init time is paid even when nothing is edited.
var lineRules = sync.OnceValue(func() struct{ comment, fromAbove, below, decorator, attribute *regexp.Regexp } {
	return struct{ comment, fromAbove, below, decorator, attribute *regexp.Regexp }{
		comment:   regexp.MustCompile(`^\s*(//|/\*|\*)`),
		fromAbove: regexp.MustCompile(`^\s*([|&.+\-*/?:,=)\]}]|=>)`),
		below:     regexp.MustCompile(`([=+\-*/|&?:,(\[{]|=>)\s*$`),
		decorator: regexp.MustCompile(`^\s*(@|#\[)`),
		attribute: regexp.MustCompile(`^\s*\[`),
	}
})

// changesNesting reports whether a change's removed or added lines may alter
// structure: they open or close blocks, add or remove a decorator or
// attribute, or continue the statement above or below. Any code change in
// Python counts. The same rule as changesNesting in src/file-index/shifts.ts.
func changesNesting(lang string, removed, added []string) bool {
	if lang == "py" {
		for _, line := range append(append([]string{}, removed...), added...) {
			trimmed := strings.TrimSpace(line)
			if trimmed != "" && !strings.HasPrefix(trimmed, "#") {
				return true
			}
		}
		return false
	}
	rules := lineRules()
	for _, lines := range [][]string{removed, added} {
		var code []string
		for _, line := range lines {
			if strings.TrimSpace(line) != "" && !rules.comment.MatchString(line) {
				code = append(code, line)
			}
		}
		if len(code) == 0 {
			continue
		}
		for _, line := range code {
			if rules.decorator.MatchString(line) || (lang == "cs" && rules.attribute.MatchString(line)) {
				return true
			}
		}
		if rules.fromAbove.MatchString(code[0]) || rules.below.MatchString(code[len(code)-1]) {
			return true
		}
		if !balanced(strings.Join(lines, "\n")) {
			return true
		}
	}
	return false
}

func balanced(text string) bool {
	curly, round, square := 0, 0, 0
	for _, c := range text {
		switch c {
		case '{':
			curly++
		case '(':
			round++
		case '[':
			square++
		case '}':
			if curly--; curly < 0 {
				return false
			}
		case ')':
			if round--; round < 0 {
				return false
			}
		case ']':
			if square--; square < 0 {
				return false
			}
		}
	}
	return curly == 0 && round == 0 && square == 0
}

// Hunk is one replaced piece of text: Old became New.
type Hunk struct {
	Old string
	New string
}

// RangesFromStructuredPatch reads Claude Code's Edit and Write tool response,
// whose "structuredPatch" numbers every changed line. Context lines are
// skipped, so only lines that really changed are marked. False when the
// response has no patch.
func RangesFromStructuredPatch(response, lang string) ([]Range, bool) {
	var parsed struct {
		Patch []struct {
			OldStart int      `json:"oldStart"`
			Lines    []string `json:"lines"`
		} `json:"structuredPatch"`
	}
	if json.Unmarshal([]byte(response), &parsed) != nil || parsed.Patch == nil {
		return nil, false
	}
	var ranges []Range
	for _, hunk := range parsed.Patch {
		line := hunk.OldStart
		from := 0
		var removed, added []string
		flush := func() {
			if len(removed) > 0 || len(added) > 0 {
				ranges = append(ranges, Range{From: from, To: from + len(removed) - 1, Delta: len(added) - len(removed), Nest: changesNesting(lang, removed, added)})
			}
			removed, added = nil, nil
		}
		for _, text := range hunk.Lines {
			if text == "" {
				flush()
				line++
				continue
			}
			switch text[0] {
			case '-':
				if len(removed) == 0 && len(added) == 0 {
					from = line
				}
				removed = append(removed, text[1:])
				line++
			case '+':
				if len(removed) == 0 && len(added) == 0 {
					from = line
				}
				added = append(added, text[1:])
			case '\\':
				// "\ No newline at end of file"
			default:
				flush()
				line++
			}
		}
		flush()
	}
	sort.Slice(ranges, func(i, j int) bool { return ranges[i].From < ranges[j].From })
	return ranges, true
}

func splitLines(text string) []string {
	text = strings.TrimSuffix(text, "\n")
	return strings.Split(text, "\n")
}

// RangesFromHunks places each hunk in the file as it is after the edit, by
// finding its new text exactly once. Lines shared at the start and end of the
// old and new text are not counted as changed. False when any hunk can't be
// placed for certain: its new text is empty, missing, or appears twice.
func RangesFromHunks(after string, hunks []Hunk, lang string) ([]Range, bool) {
	type placed struct {
		line int
		old  []string
		new  []string
	}
	var spots []placed
	for _, hunk := range hunks {
		if hunk.New == "" || hunk.Old == hunk.New {
			if hunk.Old == hunk.New {
				continue
			}
			return nil, false
		}
		first := strings.Index(after, hunk.New)
		if first < 0 || strings.Contains(after[first+1:], hunk.New) {
			return nil, false
		}
		oldText, newText := hunk.Old, hunk.New
		if strings.HasSuffix(oldText, "\n") && strings.HasSuffix(newText, "\n") {
			oldText, newText = oldText[:len(oldText)-1], newText[:len(newText)-1]
		}
		spots = append(spots, placed{line: strings.Count(after[:first], "\n") + 1, old: strings.Split(oldText, "\n"), new: strings.Split(newText, "\n")})
	}
	sort.Slice(spots, func(i, j int) bool { return spots[i].line < spots[j].line })
	var ranges []Range
	shift := 0 // lines added by earlier hunks, to turn after-edit lines into before-edit ones
	for _, spot := range spots {
		prefix := 0
		for prefix < len(spot.old) && prefix < len(spot.new) && spot.old[prefix] == spot.new[prefix] {
			prefix++
		}
		suffix := 0
		for suffix < len(spot.old)-prefix && suffix < len(spot.new)-prefix && spot.old[len(spot.old)-1-suffix] == spot.new[len(spot.new)-1-suffix] {
			suffix++
		}
		before := spot.line - shift
		delta := len(spot.new) - len(spot.old)
		removed := spot.old[prefix : len(spot.old)-suffix]
		added := spot.new[prefix : len(spot.new)-suffix]
		ranges = append(ranges, Range{From: before + prefix, To: before + len(spot.old) - 1 - suffix, Delta: delta, Nest: changesNesting(lang, removed, added)})
		shift += delta
	}
	return ranges, true
}
