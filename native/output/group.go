package output

import (
	"fmt"
	"strings"

	"github.com/mex-memory/mex/native/internal/shellparse"
)

// Group only a single recognizable command. Mixed pipelines remain whole.
func groupKind(command string) string {
	segments := shellparse.Segments(command)
	if len(segments) != 1 {
		for _, segment := range segments {
			if singleGroupKind(segment) != "" {
				return "whole"
			}
		}
		return ""
	}
	return singleGroupKind(segments[0])
}
func singleGroupKind(command string) string {

	w := program(shellparse.Words(command))
	if len(w) == 0 {
		return ""
	}
	switch base(w[0]) {
	case "rg", "grep", "egrep", "fgrep", "ag", "ack", "select-string", "sls":
		return "search"
	case "find", "fd":
		return "listing"
	case "get-childitem":
		for _, v := range w[1:] {
			if strings.EqualFold(v, "-Name") {
				return "listing"
			}
		}
		return "whole"
	case "tree":
		return "whole"
	case "git":
		switch gitSubcommand(w[1:]) {
		case "grep":
			return "search"
		case "ls-files":
			return "listing"
		}
	}
	return ""
}

var numberedHit = lazy(`(:[0-9]+:|-[0-9]+-)`)

type groupedLine struct{ path, body string }

// A unique numbered delimiter is unambiguous even with drive letters and
// colons in paths. Ambiguous unnumbered forms stay whole.
func searchLine(line string) (groupedLine, bool) {
	if line == "--" || line == "--\r" {
		return groupedLine{body: line}, true
	}
	matches := numberedHit().FindAllStringIndex(line, -1)
	if len(matches) == 1 {
		m := matches[0]
		if m[0] == 0 {
			return groupedLine{}, false
		}
		delim := line[m[0]:m[1]]
		number := delim[1 : len(delim)-1]
		prefix := number + ": "
		if delim[0] == '-' {
			prefix = "-" + number + "- "
		}
		return groupedLine{line[:m[0]], "  " + prefix + line[m[1]:]}, true
	}
	if len(matches) > 1 {
		return groupedLine{}, false
	}
	start := 0
	if len(line) > 2 && line[1] == ':' && (line[2] == '\\' || line[2] == '/') {
		start = 2
	}
	i := strings.IndexByte(line[start:], ':')
	if i < 0 {
		return groupedLine{}, false
	}
	i += start
	// More colons could belong to either the path or text; do not guess.
	if i == start || strings.Contains(line[i+1:], ":") {
		return groupedLine{}, false
	}
	return groupedLine{line[:i], "  : " + line[i+1:]}, true
}

// Group retains input order, including context separators. A file or directory
// starts a new block when it reappears, so expansion needs no hidden ordering.
func Group(text, kind, ref string) (string, bool) {
	if len(text) <= MinChars || kind == "whole" {
		return text, false
	}
	var parsed []groupedLine
	paths := map[string]bool{}
	hits := 0
	for _, line := range splitLines(text) {
		var g groupedLine
		var ok bool
		if kind == "search" {
			g, ok = searchLine(line)
		} else if kind == "listing" {
			// Preserve separator style and exact path bytes, including CRLF.
			i := strings.LastIndexAny(line, `/\`)
			if i >= 0 && i < len(line)-1 {
				g = groupedLine{line[:i+1], "  " + line[i+1:]}
				ok = true
			} else if i < 0 && strings.TrimSpace(line) != "" {
				g = groupedLine{".", "  " + line}
				ok = true
			}
		}
		if !ok || strings.HasPrefix(g.path, "  ") || g.path == "--" || g.path == "--\r" {
			return text, false
		}
		parsed = append(parsed, g)
		if g.path != "" {
			paths[g.path] = true
			hits++
		}
	}
	var b strings.Builder
	last := ""
	for _, g := range parsed {
		if g.path == "" {
			b.WriteString(g.body)
			b.WriteByte('\n')
			last = ""
			continue
		}
		if g.path != last {
			b.WriteString(g.path)
			b.WriteByte('\n')
			last = g.path
		}
		b.WriteString(g.body)
		b.WriteByte('\n')
	}
	if !strings.HasSuffix(text, "\n") {
		body := b.String()
		b.Reset()
		b.WriteString(strings.TrimSuffix(body, "\n"))
	}
	noun, unit := "search output grouped by file", "hits"
	containers := "files"
	if kind == "listing" {
		noun, unit = "listing grouped by directory", "paths"
		containers = "directories"
	}
	head := fmt.Sprintf("[MEX: %s \u00b7 nothing dropped \u00b7 %s %s in %s %s \u00b7 full text: %s]\n", noun, group(hits), unit, group(len(paths)), containers, ref)
	result := head + b.String()
	if float64(len(result)) > (1-MinSaving)*float64(len(text)) {
		return text, false
	}
	return result, true
}

// PresentAndSave never uses lossy trimming for a search or listing.
func PresentAndSave(command, text string, exitCode int, save func() (int, error)) (string, bool) {
	kind := groupKind(command)
	if kind == "" {
		return TrimAndSave(text, exitCode, save)
	}
	if exitCode != 0 || kind == "whole" {
		return text, false
	}
	grouped, ok := Group(text, kind, refPlaceholder)
	if !ok {
		return text, false
	}
	n, err := save()
	if err != nil {
		return text, false
	}
	result := strings.Replace(grouped, refPlaceholder, Ref(n), 1)
	if float64(len(result)) > (1-MinSaving)*float64(len(text)) {
		return text, false
	}
	return result, true
}
