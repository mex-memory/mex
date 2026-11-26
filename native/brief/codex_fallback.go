package brief

import (
	"encoding/json"
	"os"
	"path"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/record"
)

const codexFallbackKey = "native.codex-fallback.v1"
const codexFallbackHeading = "## MEX rules (Codex fallback)\n\n"
const codexFileBytes = 8 << 10

type fallbackEntry struct {
	ID, Level, Text, Line string
	Areas                 []string
}

type fallbackPlan struct {
	Entries                    []fallbackEntry
	FrameBytes                 int
	Decisions, DefaultsHeading string
	Defaults                   []string
}

// Match JavaScript's whitespace normalization in the native renderer.
func normalizeFallbackText(text string) string {
	parts := strings.FieldsFunc(text, func(r rune) bool {
		return r == '\uFEFF' || unicode.IsSpace(r) && r != '\u0085'
	})
	return strings.Join(parts, " ")
}

func fallbackEntryLine(text, id string) string {
	return "- " + normalizeFallbackText(text) + " <!-- mex:" + id + " -->"
}

func matchesFallbackEntry(item fallbackEntry, entry *entries.Entry) bool {
	if entry.Text != item.Text {
		return false
	}
	if item.Line == fallbackEntryLine(entry.Text, entry.ID) {
		return true // A plan written before compact delivery can still use the body.
	}
	if !entry.Learned() || slices.ContainsFunc(entry.Scope, func(scope string) bool { return scope != "**" }) {
		return false
	}
	claim := normalizeFallbackText(entry.OneLine)
	return strings.TrimRight(claim, ".!?") != claim &&
		strings.HasPrefix(normalizeFallbackText(entry.Text), claim+" ") &&
		item.Line == fallbackEntryLine(claim, entry.ID)
}

// A native file takes precedence even if its manifest is missing or stale:
// Codex can read that file independently of MEX.
func codexSlotBlocked(root *os.Root, area string) bool {
	if info, err := root.Lstat(path.Join(area, "AGENTS.override.md")); err == nil && info.Mode().IsRegular() && info.Size() > 0 {
		return true
	}
	name := path.Join(area, "AGENTS.md")
	body, err := readFile(root, name, maxRuleBytes)
	return err == nil && !strings.Contains(string(body), "<!-- mex:generated")
}

func codexFallback(root *os.Root, opts Options, state *record.Reader, available func(fallbackEntry, string) bool) (string, []fallbackEntry) {
	if !opts.IncludeCodexFallback || opts.Agent != "codex" || opts.AgentID != "" || state == nil {
		return "", nil
	}
	blocked := map[string]bool{"": codexSlotBlocked(root, "")}
	if opts.Path != "" {
		parent := ""
		for _, segment := range strings.Split(opts.Path, "/") {
			parent = path.Join(parent, segment)
			blocked[parent] = codexSlotBlocked(root, parent)
		}
	}
	shadowed := false
	for _, denied := range blocked {
		shadowed = shadowed || denied
	}
	if !shadowed {
		return "", nil
	}
	data, found, err := state.BoundedSetting("checkout:"+opts.Checkout, codexFallbackKey, 256<<10)
	var plan fallbackPlan
	if err != nil || !found || json.Unmarshal([]byte(data), &plan) != nil {
		return "", nil
	}
	goodLine := func(line string) bool {
		return strings.HasPrefix(line, "- ") && validLine(line) && !strings.ContainsAny(line, "\r\n")
	}
	goodHeader := func(line string) bool {
		return len(line) <= 256 && utf8.ValidString(line) && !strings.Contains(line, "[mex ")
	}
	if len(plan.Defaults) > 15 || !goodHeader(plan.DefaultsHeading) || plan.FrameBytes < 0 || plan.FrameBytes > 256 ||
		plan.Decisions != "" && !goodLine(strings.TrimSuffix(plan.Decisions, "\n")) {
		return "", nil
	}
	for _, line := range plan.Defaults {
		if !goodLine(strings.TrimSuffix(line, "\n")) || !strings.HasSuffix(line, "\n") {
			return "", nil
		}
	}
	var text strings.Builder
	text.WriteString(codexFallbackHeading)
	if blocked[""] {
		text.WriteString(plan.Decisions)
	}
	// Reserve the native file's header bytes even though this section has a
	// shorter title. A fallback must not win more rule space than the file.
	frame := max(0, plan.FrameBytes-len(codexFallbackHeading))
	room := func(line string) bool { return frame+text.Len()+len(line) <= codexFileBytes }
	var accepted []fallbackEntry
	seen := map[string]bool{}
	for _, item := range plan.Entries {
		if seen[item.ID] || !goodLine(item.Line) || !room(item.Line+"\n") {
			continue
		}
		for _, area := range item.Areas {
			if blocked[area] && available(item, area) {
				seen[item.ID] = true
				accepted = append(accepted, item)
				text.WriteString(item.Line + "\n")
				break
			}
		}
	}
	if blocked[""] {
		header := plan.DefaultsHeading
		for _, line := range plan.Defaults {
			if room(header + line) {
				text.WriteString(header + line)
				header = ""
			}
		}
	}
	if text.Len() == len(codexFallbackHeading) {
		return "", nil
	}
	return text.String(), accepted
}
