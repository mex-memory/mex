package brief

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/check"
)

const project = "g-0123456789abcdef01234567"

func put(t *testing.T, root, file, text string) {
	t.Helper()
	full := filepath.Join(root, filepath.FromSlash(file))
	if err := os.MkdirAll(filepath.Dir(full), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(full, []byte(text), 0600); err != nil {
		t.Fatal(err)
	}
}

func entry(id, line, kind, scope, checks string) string {
	return "---\nmex:\n  id: " + id + "\n  kind: " + kind + "\n  scope: [\"" + scope + "\"]\n  source: {type: docs, ref: README.md}\n  evidence: docs\n  one_line: \"" + line + "\"\n  status: active\n  created: 2026-11-15\n  checks: " + checks + "\n---\n" + line + "\n"
}

func setup(t *testing.T) Options {
	t.Helper()
	return Options{Checkout: t.TempDir(), MexHome: t.TempDir(), ProjectID: project, Agent: "codex"}
}

func build(t *testing.T, opts Options) Result {
	t.Helper()
	r, err := Build(opts)
	if err != nil {
		t.Fatal(err)
	}
	if r.Tokens != TokenBound(r.Text) || r.Tokens > MaxTokens+MaxNoteTokens {
		t.Fatalf("budget: %+v", r)
	}
	return r
}

func TestBriefPriorityPersonalThenAtMostThreeAreaClaims(t *testing.T) {
	opts := setup(t)
	opts.Path = "apps/api/handler.ts"
	for _, id := range []string{"mx_rule01", "mx_rule02", "mx_rule03", "mx_rule04"} {
		put(t, opts.Checkout, ".mex/learned/"+id+".md", entry(id, "Small claim.", "rule", "apps/api/**", "[]"))
	}
	put(t, opts.MexHome, "projects/"+project+"/notes/mx_note01.md", entry("mx_note01", "Small commits.", "rule", "**", "[]"))
	put(t, opts.Checkout, ".mex/learned/mx_other1.md", entry("mx_other1", "Other area.", "rule", "apps/web/**", "[]"))
	r := build(t, opts)
	if !strings.HasPrefix(r.Text, "[mex start-preview]\n"+Priority+"\n[personal, from docs] Small commits.") {
		t.Fatal(r.Text)
	}
	area := 0
	for _, item := range r.Items {
		if item.Level != "personal" {
			area++
		}
	}
	if area > 3 || strings.Contains(r.Text, "Other area") {
		t.Fatal(r.Text)
	}
	if again := build(t, opts); again.Text != r.Text {
		t.Fatal("same inputs changed the brief")
	}
}

// A session that starts on a busy machine can pass the deadline before the
// first entry is looked at. The person's own notes still go out; team
// entries are what waits for the moments.
func TestBriefKeepsThePersonsNotesPastTheDeadline(t *testing.T) {
	opts := setup(t)
	put(t, opts.Checkout, ".mex/learned/mx_rule01.md", entry("mx_rule01", "Team claim.", "rule", "**", "[]"))
	put(t, opts.MexHome, "projects/"+project+"/notes/mx_note01.md", entry("mx_note01", "Small commits.", "rule", "**", "[]"))
	opts.Deadline = time.Now().Add(-time.Second)
	r := build(t, opts)
	if len(r.Items) != 1 || r.Items[0].ID != "mx_note01" || strings.Contains(r.Text, "Team claim") {
		t.Fatal(r.Text)
	}
	// Bounded: past the deadline at most maxLateNotes notes are checked. Notes
	// too long to fit use those checks up, so the short one after them waits.
	for i := 0; i < maxLateNotes+2; i++ {
		id := fmt.Sprintf("mx_long%02d", i)
		put(t, opts.MexHome, "projects/"+project+"/notes/"+id+".md", entry(id, strings.Repeat("界", 300), "rule", "**", "[]"))
	}
	if r = build(t, opts); len(r.Items) != 0 {
		t.Fatal(r.Text)
	}
	opts.Deadline = time.Time{}
	if r = build(t, opts); len(r.Items) == 0 || r.Items[0].ID != "mx_note01" {
		t.Fatal(r.Text)
	}
}

// The person's notes have their own budget (MaxNoteTokens) beside the one
// for team entries and commands (MaxTokens): notes never crowd out the team's
// lines, and team lines never crowd out the notes.
func TestBriefGivesThePersonsNotesTheirOwnRoom(t *testing.T) {
	opts := setup(t)
	for i := 0; i < 6; i++ {
		id := fmt.Sprintf("mx_note%02d", i)
		put(t, opts.MexHome, "projects/"+project+"/notes/"+id+".md", entry(id, fmt.Sprintf("Note %d: deploys from the release branch only, after the QA sign-off.", i), "rule", "**", "[]"))
	}
	put(t, opts.Checkout, ".mex/learned/mx_team01.md", entry("mx_team01", "Team claim.", "rule", "**", "[]"))
	count := func(r Result) (notes, noteTokens int) {
		for _, item := range r.Items {
			if item.Level == "personal" {
				notes++
				noteTokens += item.Tokens
			}
		}
		return
	}
	r := build(t, opts)
	if notes, _ := count(r); notes != 6 || !strings.Contains(r.Text, "Team claim") {
		t.Fatal(r.Text)
	}
	// More notes than their budget holds: whole notes up to MaxNoteTokens,
	// and the team's line still goes out.
	for i := 6; i < 16; i++ {
		id := fmt.Sprintf("mx_note%02d", i)
		put(t, opts.MexHome, "projects/"+project+"/notes/"+id+".md", entry(id, fmt.Sprintf("Note %d: deploys from the release branch only, after the QA sign-off.", i), "rule", "**", "[]"))
	}
	r = build(t, opts)
	notes, noteTokens := count(r)
	if notes < 6 || notes >= 16 || noteTokens > MaxNoteTokens || !strings.Contains(r.Text, "Team claim") {
		t.Fatalf("%d notes, %d tokens: %s", notes, noteTokens, r.Text)
	}
}

func TestBriefSelectsWholeClaimsWithinHardBoundIncludingUnicode(t *testing.T) {
	opts := setup(t)
	// A character outside ASCII counts as a whole token: 320 of them can't fit.
	put(t, opts.Checkout, ".mex/learned/mx_long01.md", entry("mx_long01", strings.Repeat("界", 320), "rule", "**", "[]"))
	for i, line := range []string{"First.", "Second.", "Third.", "Fourth."} {
		id := []string{"mx_short1", "mx_short2", "mx_short3", "mx_short4"}[i]
		put(t, opts.Checkout, ".mex/learned/"+id+".md", entry(id, line, "rule", "**", "[]"))
	}
	r := build(t, opts)
	if strings.Contains(r.Text, "界") || !strings.Contains(r.Text, "Third") || r.Tokens > MaxTokens {
		t.Fatal(r.Text)
	}
}

// The calibrated estimate: prose at 4 bytes a token, text in backticks at
// 2.3, and any character outside ASCII as a whole token.
func TestTokenBound(t *testing.T) {
	cases := []struct {
		text string
		want int
	}{
		{"", 0},
		{"abcd", 1},
		{"abcde", 2},
		{"Run `npm test` first.", 1 + 4 + 2}, // "Run " 4/4, "npm test" 8/2.3, " first." 7/4
		{strings.Repeat("界", 10), 10},
	}
	for _, c := range cases {
		if got := TokenBound(c.text); got != c.want {
			t.Errorf("%q: %d, want %d", c.text, got, c.want)
		}
	}
}

func TestBrokenAndChangedRecipesNeverEnterTheBrief(t *testing.T) {
	opts := setup(t)
	checks := "\n    - kind: key\n      role: complete\n      target: {file: package.json, pointer: /scripts/test}\n      saw: {value: old}\n      files: {}"
	put(t, opts.Checkout, "package.json", `{"scripts":{"test":"new"}}`)
	put(t, opts.Checkout, ".mex/learned/mx_broken.md", entry("mx_broken", "Never send the old command.", "recipe", "**", checks))
	put(t, opts.Checkout, ".mex/learned/mx_change.md", entry("mx_change", "Never send this changed recipe.", "recipe", "**", strings.Replace(checks, "complete", "supporting", 1)))
	put(t, opts.Checkout, ".mex/learned/mx_fact01.md", entry("mx_fact01", "A code fact belongs at an edit.", "fact", "**", "[]"))
	put(t, opts.Checkout, ".mex/learned/mx_hint01.md", entry("mx_hint01", "A hint belongs at a failure.", "hint", "**", "[]"))
	put(t, opts.Checkout, ".mex/learned/mx_held01.md", entry("mx_held01", "The current recipe.", "recipe", "**", strings.Replace(checks, "value: old", "value: new", 1)))
	r := build(t, opts)
	if len(r.Items) != 1 || r.Items[0].ID != "mx_held01" || r.Items[0].Verdict != check.Held {
		t.Fatal(r)
	}
	// Re-evaluate canonical checks, rather than trusting an old held cache.
	put(t, opts.Checkout, "package.json", `{"scripts":{}}`)
	if r := build(t, opts); len(r.Items) != 0 {
		t.Fatal(r)
	}
}

func TestSetupRecipesLeaveRoomForPersonalNotes(t *testing.T) {
	opts := setup(t)
	for _, id := range []string{"mx_setup0123456789abcdef01234567", "mx_setup1123456789abcdef01234567"} {
		body := strings.Replace(entry(id, "Build command.", "recipe", "**", "[]"), "type: docs, ref: README.md", "type: config, ref: package.json", 1)
		put(t, opts.MexHome, "projects/"+project+"/notes/"+id+".md", body)
	}
	put(t, opts.MexHome, "projects/"+project+"/notes/mx_person.md", entry("mx_person", "My tests.", "recipe", "**", "[]"))
	r := build(t, opts)
	if len(r.Items) != 1 || r.Items[0].ID != "mx_person" || strings.Contains(r.Text, "Build command") {
		t.Fatal(r.Text)
	}
	// A stale setup recipe already in native files still asks for a rebuild,
	// but its correction must not displace the person's note from the brief.
	id := "mx_setup0123456789abcdef01234567"
	checks := "\n    - kind: command\n      role: complete\n      target: {file: package.json, pointer: /scripts/build, run: npm run build}\n      saw: {exists: true}\n      files: {}"
	body := strings.Replace(entry(id, "Build command.", "recipe", "**", checks), "type: docs, ref: README.md", "type: config, ref: package.json", 1)
	put(t, opts.MexHome, "projects/"+project+"/notes/"+id+".md", body)
	text := "<!-- mex:generated -->\n- Build command. <!-- mex:" + id + " -->\n"
	put(t, opts.Checkout, "AGENTS.md", text)
	manifest(t, opts.MexHome, "projects/"+project+"/native-local.json", "AGENTS.md", text)
	r = build(t, opts)
	if !r.NativeStale || len(r.Corrections) != 0 || len(r.Items) != 1 || r.Items[0].ID != "mx_person" {
		t.Fatalf("setup recipe consumed brief room: %+v", r)
	}
}

func manifest(t *testing.T, root, file, name, text string) {
	t.Helper()
	data, _ := json.Marshal(map[string]any{"version": 1, "files": map[string]string{name: hash([]byte(text))}})
	put(t, root, file, string(data))
}

func TestCoverageUsesActualGeneratedFilesAndScopes(t *testing.T) {
	opts := setup(t)
	opts.Path = "apps/api/main.ts"
	text := "<!-- mex:generated -->\n- Use narrow types. <!-- mx_rule01 -->\n"
	put(t, opts.Checkout, ".mex/learned/mx_rule01.md", entry("mx_rule01", "Use narrow types.", "rule", "apps/api/**", "[]"))
	put(t, opts.Checkout, "apps/api/AGENTS.md", text)
	manifest(t, opts.Checkout, ".mex/native.json", "apps/api/AGENTS.md", text)
	r := build(t, opts)
	if len(r.Items) != 0 || !r.Coverage.Covers("mx_rule01", "codex", opts.Path) || r.Coverage.Covers("mx_rule01", "codex", "apps/web/main.ts") {
		t.Fatal(r)
	}
	// Codex's native chain follows the host CWD, not a tool's target file.
	opts.NativeCwd = opts.Checkout
	if r := build(t, opts); len(r.Items) != 1 || r.Coverage.Covers("mx_rule01", "codex", opts.Path) {
		t.Fatal("a root session did not load the nested AGENTS file", r)
	}
	opts.NativeCwd = filepath.Join(opts.Checkout, "apps/api")
	if r := build(t, opts); len(r.Items) != 0 {
		t.Fatal("the API-area session already loads this file", r)
	}
	opts.NativeCwd = ""
	put(t, opts.Checkout, "AGENTS.md", strings.Repeat("x", 32<<10))
	if r := build(t, opts); len(r.Items) != 1 {
		t.Fatal("the ancestor instruction budget excludes this nested file", r)
	}
	if err := os.Remove(filepath.Join(opts.Checkout, "AGENTS.md")); err != nil {
		t.Fatal(err)
	}
	// A hand edit, missing file, or overriding instruction invalidates coverage.
	put(t, opts.Checkout, "apps/api/AGENTS.override.md", "Person's replacement.")
	if r := build(t, opts); len(r.Items) != 1 {
		t.Fatal(r)
	}
	if err := os.Remove(filepath.Join(opts.Checkout, "apps/api/AGENTS.override.md")); err != nil {
		t.Fatal(err)
	}
	put(t, opts.Checkout, "apps/api/AGENTS.md", text+"Person's edit.\n")
	if r := build(t, opts); len(r.Items) != 1 {
		t.Fatal(r)
	}
}

func TestClaudeRulesAndHiddenPersonalCoverage(t *testing.T) {
	opts := setup(t)
	opts.Agent, opts.Path = "claude-code", "apps/api/handler.ts"
	text := "---\npaths:\n  - apps/api/**\n---\n<!-- mex:generated -->\n- Small commits. <!-- mx_note01 -->\n"
	put(t, opts.MexHome, "projects/"+project+"/notes/mx_note01.md", entry("mx_note01", "Small commits.", "rule", "**", "[]"))
	put(t, opts.Checkout, ".claude/rules/mex-local-api.md", text)
	manifest(t, opts.MexHome, "projects/"+project+"/native-local.json", ".claude/rules/mex-local-api.md", text)
	if r := build(t, opts); len(r.Items) != 0 {
		t.Fatal(r)
	}
	opts.Path = "apps/web/main.ts"
	if r := build(t, opts); len(r.Items) != 1 {
		t.Fatal(r)
	}
}

func TestCompanionsTravelTogetherOrWait(t *testing.T) {
	opts := setup(t)
	first := strings.Replace(entry("mx_first1", "First claim.", "rule", "**", "[]"), "  status:", "  companions: [mx_second]\n  status:", 1)
	put(t, opts.Checkout, ".mex/learned/mx_first1.md", first)
	if r := build(t, opts); len(r.Items) != 0 {
		t.Fatal(r)
	}
	put(t, opts.Checkout, ".mex/learned/mx_second.md", entry("mx_second", "Required companion.", "rule", "**", "[]"))
	if r := build(t, opts); len(r.Items) != 2 {
		t.Fatal(r)
	}
}

func TestDuplicateSourcesCannotChooseAnArbitraryBriefClaim(t *testing.T) {
	opts := setup(t)
	put(t, opts.Checkout, ".mex/learned/mx_rule01.md", entry("mx_rule01", "First claim.", "rule", "**", "[]"))
	put(t, opts.Checkout, ".mex/learned/rule/mx_rule01.md", entry("mx_rule01", "Different claim.", "rule", "**", "[]"))
	if _, err := Build(opts); err == nil {
		t.Fatal("duplicate canonical ids chose an arbitrary claim")
	}
}

func TestUnsafeAndOutsideStoresAreNeverRead(t *testing.T) {
	opts := setup(t)
	outside := t.TempDir()
	put(t, outside, "mx_secret.md", entry("mx_secret", "Outside content.", "rule", "**", "[]"))
	put(t, opts.Checkout, ".mex/keep", "")
	if err := os.Symlink(outside, filepath.Join(opts.Checkout, ".mex/learned")); err != nil {
		t.Skip(err)
	}
	if _, err := Build(opts); err == nil {
		t.Fatal("followed a linked store")
	}
	opts.Path = "../other"
	if _, err := Build(opts); err == nil {
		t.Fatal("accepted an outside path")
	}
}

func TestRuleCacheIsBoundToCurrentCheckoutAndRuleBytes(t *testing.T) {
	opts := setup(t)
	text := "# Style\n\nUse narrow types.\n"
	put(t, opts.Checkout, "CLAUDE.md", text)
	var cache map[string]any
	raw := `{"version":1,"files":[{"path":"CLAUDE.md","format":"claude","agents":["claude-code"],"scope":["**"]}],"entries":[{"path":"CLAUDE.md","entry":{"mex":{"id":"mx_import","kind":"rule","scope":["**"],"source":{"type":"rule-file","ref":"CLAUDE.md"},"evidence":"docs","one_line":"Use narrow types.","status":"active","created":"2026-11-15","checks":[]},"text":"Use narrow types."}}]}`
	if err := json.Unmarshal([]byte(raw), &cache); err != nil {
		t.Fatal(err)
	}
	cache["root"] = opts.Checkout
	cache["files"].([]any)[0].(map[string]any)["hash"] = hash([]byte(text))
	save := func() {
		data, _ := json.Marshal(cache)
		put(t, opts.MexHome, "projects/"+project+"/rule-files.json", string(data))
	}
	save()
	if r := build(t, opts); len(r.Items) != 1 {
		t.Fatal(r)
	}
	opts.Agent = "claude-code"
	if r := build(t, opts); len(r.Items) != 0 {
		t.Fatal(r)
	}
	opts.Agent = "codex"
	cache["review"] = []any{map[string]any{"paths": []string{"CLAUDE.md"}}}
	save()
	if r := build(t, opts); len(r.Items) != 0 {
		t.Fatal(r)
	}
	delete(cache, "review")
	cache["root"] = t.TempDir()
	save()
	if r := build(t, opts); len(r.Items) != 0 {
		t.Fatal(r)
	}
	cache["root"] = opts.Checkout
	save()
	put(t, opts.Checkout, "CLAUDE.md", "Changed since the scan.")
	if r := build(t, opts); len(r.Items) != 0 {
		t.Fatal(r)
	}
}

func TestStaleNoteInMexRuleFilesIsRetractedAndRebuildAsked(t *testing.T) {
	opts := setup(t)
	opts.Agent = "claude-code"
	checks := "\n    - kind: key\n      role: complete\n      target: {file: package.json, pointer: /scripts/test}\n      saw: {value: vitest}\n      files: {}"
	put(t, opts.MexHome, "projects/"+project+"/notes/mx_note02.md", entry("mx_note02", "Tests run with vitest.", "fact", "**", checks))
	text := "<!-- mex:generated -->\n- Tests run with vitest. <!-- mx_note02 -->\n"
	put(t, opts.Checkout, ".claude/rules/mex-local.md", text)
	manifest(t, opts.MexHome, "projects/"+project+"/native-local.json", ".claude/rules/mex-local.md", text)
	put(t, opts.Checkout, "package.json", `{"scripts":{"test":"vitest"}}`)
	if r := build(t, opts); len(r.Corrections) != 0 || r.NativeStale || len(r.Items) != 0 {
		t.Fatalf("a held note the agent already loads needs nothing: %+v", r)
	}
	// The code moved on: the agent loaded a note that no longer holds.
	put(t, opts.Checkout, "package.json", `{"scripts":{"test":"jest"}}`)
	r := build(t, opts)
	if !r.NativeStale || len(r.Corrections) != 1 || r.Corrections[0].ID != "mx_note02" || len(r.Items) != 0 {
		t.Fatalf("stale loaded note not retracted: %+v", r)
	}
	if !strings.Contains(r.Text, "Correction: the MEX note mx_note02") || strings.Contains(r.Text, "vitest") {
		t.Fatalf("correction must name the note without repeating it: %q", r.Text)
	}
}

func TestChangedPersonalFactIsNotRestatedInTheBrief(t *testing.T) {
	opts := setup(t)
	checks := "\n    - kind: key\n      role: supporting\n      target: {file: package.json, pointer: /scripts/test}\n      saw: {value: vitest}\n      files: {}"
	put(t, opts.MexHome, "projects/"+project+"/notes/mx_note03.md", entry("mx_note03", "Tests run with vitest.", "fact", "**", checks))
	put(t, opts.Checkout, "package.json", `{"scripts":{"test":"vitest"}}`)
	if r := build(t, opts); len(r.Items) != 1 {
		t.Fatalf("a held personal fact is given: %+v", r)
	}
	put(t, opts.Checkout, "package.json", `{"scripts":{"test":"jest"}}`)
	if r := build(t, opts); len(r.Items) != 0 {
		t.Fatalf("a changed personal fact was restated: %+v", r)
	}
}

// A repo with its own AGENTS.md: MEX writes no rule file there, so the root
// command reaches Codex in the brief, after the person's note, while it holds.
func TestRootCommandReachesAnAgentWithNoRuleFileForIt(t *testing.T) {
	opts := setup(t)
	opts.Agent = "codex"
	put(t, opts.Checkout, "package.json", `{"scripts":{"lint":"eslint ."}}`)
	put(t, opts.Checkout, "AGENTS.md", "# Our own rules\n")
	id := "mx_setup2123456789abcdef01234567"
	checks := "\n    - kind: command\n      role: complete\n      target: {file: package.json, pointer: /scripts/lint, run: npm run lint}\n      saw: {exists: true}\n      files: {}"
	body := strings.Replace(entry(id, "Lint: `npm run lint`", "recipe", "**", checks), "type: docs, ref: README.md", "type: config, ref: package.json", 1)
	put(t, opts.MexHome, "projects/"+project+"/notes/"+id+".md", body)
	put(t, opts.MexHome, "projects/"+project+"/notes/mx_person.md", entry("mx_person", "My tests.", "rule", "**", "[]"))
	r := build(t, opts)
	if len(r.Items) != 2 || r.Items[0].ID != "mx_person" || r.Items[1].ID != id {
		t.Fatalf("root command missing or ahead of the person's note: %+v", r.Items)
	}
	// Gone from package.json: never sent.
	put(t, opts.Checkout, "package.json", `{"scripts":{}}`)
	if r := build(t, opts); len(r.Items) != 1 {
		t.Fatalf("a command whose script is gone was sent: %+v", r.Items)
	}
}
