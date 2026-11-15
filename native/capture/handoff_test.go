package capture

import (
	"strings"
	"testing"
)

func TestHandoffSlugMatchesNode(t *testing.T) {
	// Same vectors as src/knowledge/__tests__/handoff.test.ts.
	for in, want := range map[string]string{
		"feat/billing":           "feat-billing",
		"user/ünï code//x":       "user-n-code-x",
		"..hidden.":              "hidden",
		"///":                    "branch",
		strings.Repeat("a", 120): strings.Repeat("a", 100),
	} {
		if got := HandoffSlug(in); got != want {
			t.Errorf("HandoffSlug(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseHandoffReadsWhatNodeWrites(t *testing.T) {
	text := "---\nmex: handoff\nversion: 1\nbranch: \"feat/billing\"\nfrom: \"Alex\"\nto: \"Sam\"\ncreated: 2026-11-15\n---\nAlex handed off feat/billing to Sam:\n- Branch: feat/billing (at 1a2b3c4)\n- From Alex: start with the tax rounding\n"
	h, ok := ParseHandoff(text)
	if !ok || h.Branch != "feat/billing" || h.From != "Alex" || !strings.HasPrefix(h.Body, "Alex handed off") || !strings.HasSuffix(h.Body, "tax rounding") {
		t.Fatalf("%+v %v", h, ok)
	}
	for _, bad := range []string{"", "no front matter", "---\nmex: note\nbranch: x\n---\nbody", "---\nmex: handoff\n---\nbody", "---\nmex: handoff\nbranch: x\n---\n"} {
		if _, ok := ParseHandoff(bad); ok {
			t.Errorf("parsed %q", bad)
		}
	}
}
