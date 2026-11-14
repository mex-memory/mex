package check

import (
	"strings"
)

var (
	atxHeading    = lazy(`^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$`)
	setextHeading = lazy(`^ {0,3}(=+|-+)[ \t]*$`)
	fence         = lazy("^ {0,3}(```+|~~~+)")
	whitespace    = lazy(`\s+`)
)

type heading struct {
	line, level int
	text        string
}

// headings lists a Markdown file's ATX and setext headings, skipping code
// fences.
func headings(lines []string) []heading {
	var out []heading
	inFence := ""
	for i, line := range lines {
		if m := fence().FindStringSubmatch(line); m != nil {
			marker := m[1][:3]
			if inFence == "" {
				inFence = marker
			} else if inFence == marker {
				inFence = ""
			}
			continue
		}
		if inFence != "" {
			continue
		}
		if m := atxHeading().FindStringSubmatch(line); m != nil {
			out = append(out, heading{line: i, level: len(m[1]), text: strings.TrimSpace(m[2])})
			continue
		}
		if i > 0 && strings.TrimSpace(lines[i-1]) != "" && setextHeading().MatchString(line) {
			if len(out) > 0 && out[len(out)-1].line == i-1 {
				continue
			}
			level := 2
			if strings.Contains(line, "=") {
				level = 1
			}
			out = append(out, heading{line: i - 1, level: level, text: strings.TrimSpace(lines[i-1])})
		}
	}
	return out
}

// section returns the text under the first heading named exactly title, up
// to the next heading of the same or a higher level.
func section(data []byte, title string) (string, bool) {
	lines := strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n")
	hs := headings(lines)
	for i, h := range hs {
		if h.text != strings.TrimSpace(title) {
			continue
		}
		start := h.line + 1
		if start < len(lines) && setextHeading().MatchString(lines[start]) && !atxHeading().MatchString(lines[h.line]) {
			start++
		}
		end := len(lines)
		for _, next := range hs[i+1:] {
			if next.level <= h.level {
				end = next.line
				break
			}
		}
		if start > end {
			start = end
		}
		return strings.Join(lines[start:end], "\n"), true
	}
	return "", false
}

// textHash hashes prose with whitespace runs collapsed, so re-wrapping,
// indentation and blank lines don't count as a change.
func textHash(text string) string {
	return hashBytes([]byte(strings.TrimSpace(whitespace().ReplaceAllString(text, " "))))
}
