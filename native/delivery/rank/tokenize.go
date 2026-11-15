// Package rank is the shared, deterministic prompt and recall ranker.
package rank

import (
	"strings"
	"unicode"
)

const stopWords = "the a an and or of to in on for with from by is are was were be been how what why when which " +
	"who does do did this that these those it its into via as at than then there their they you your " +
	"not no can will would should could about after before over under between only also just more " +
	"most some any each every one two all get got make made use used using please explain describe " +
	"tell show find want need look let see give say way thing things happen happens happening works " +
	"work working really actually exactly whether might must may"

func stem(w string) string {
	for _, s := range []string{"ing", "ed", "es", "s"} {
		if len(w) > len(s)+3 && strings.HasSuffix(w, s) {
			w = strings.TrimSuffix(w, s)
			break
		}
	}
	if len(w) > 4 && strings.HasSuffix(w, "e") {
		w = strings.TrimSuffix(w, "e")
	}
	return w
}
func Tokens(text string) []string {
	var split strings.Builder
	var prev rune
	for _, r := range text {
		if unicode.IsUpper(r) && unicode.IsLower(prev) {
			split.WriteByte(' ')
		}
		split.WriteRune(unicode.ToLower(r))
		prev = r
	}
	var out []string
	for _, w := range strings.FieldsFunc(split.String(), func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
		if len(w) > 2 && !strings.Contains(" "+stopWords+" ", " "+w+" ") {
			out = append(out, stem(w))
		}
	}
	return out
}
func windows(s string) []string {
	words := strings.Fields(s)
	if len(words) <= 60 {
		return []string{s}
	}
	var out []string
	for i := 0; i < len(words) && len(out) < 12; i += 28 {
		out = append(out, strings.Join(words[i:min(i+40, len(words))], " "))
		if i+40 >= len(words) {
			break
		}
	}
	return out
}
func identifiers(s string) []string {
	var out []string
	for _, w := range strings.FieldsFunc(s, func(r rune) bool { return unicode.IsSpace(r) || strings.ContainsRune("`\"',;:<>[]{}", r) }) {
		w = strings.Trim(w, ".!?()")
		camel := false
		for _, r := range w {
			if unicode.IsUpper(r) {
				camel = true
				break
			}
		}
		if len(w) >= 3 && (strings.ContainsAny(w, "/._") || camel || strings.Contains(s, w+"()") || strings.Contains(s, "`"+w+"`")) {
			out = append(out, strings.ToLower(w))
		}
	}
	return out
}

// Machine-written envelopes and standalone tool/log pastes never form prompt
// moments. A human sentence containing a quoted snippet is still a request.
func Machine(text string) bool {
	s := strings.TrimSpace(text)
	lower := strings.ToLower(s)
	for _, p := range []string{"<task-notification", "<system-reminder", "<hook_", "<tool_result", "<command-name>", "```", "diff --git ", "exit code:", "tool output:", "error:", "traceback ("} {
		if strings.HasPrefix(lower, p) {
			return true
		}
	}
	return strings.HasPrefix(s, "/") && !strings.HasPrefix(s, "//")
}
