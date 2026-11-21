package delivery

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/internal/adapter"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record"
)

func TestSimilarityBeforeCutAndAcrossEpochPresence(t *testing.T) {
	f := newFixture(t)
	for _, id := range []string{"mx_sameaa", "mx_samebb"} {
		f.entry(spec{id: id, kind: "pitfall", scope: "src/**", oneLine: "Keep the shared database pool open for later requests."})
	}
	f.entry(spec{id: "mx_othera", kind: "pitfall", scope: "src/**", oneLine: "Generated routes must be changed through their source template."})
	text := f.send(f.event(contract.PostToolBatch, read(f.file("src/a.ts", "x"), "x")))
	if strings.Count(text, "shared database") != 1 || !strings.Contains(text, "Generated routes") {
		t.Fatal(text)
	}
	db, err := sql.Open("sqlite", filepath.Join(f.dir, "hooks.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var n int
	if err = db.QueryRow("SELECT count(*) FROM deliveries WHERE action='withheld' AND detail='similar'").Scan(&n); err != nil || n != 1 {
		t.Fatal(n, err)
	}
	f.entry(spec{id: "mx_samecc", kind: "pitfall", scope: "src/**", oneLine: "Keep the shared database pool open for later requests."})
	mustBeEmpty(t, f.send(f.event(contract.PostToolBatch, read(f.file("src/b.ts", "x"), "x"))))
}
func TestNativeTextSimilarityWithoutMarker(t *testing.T) {
	f := newFixture(t)
	f.file("CLAUDE.md", "# Pool\nKeep the shared database pool open for later requests.\n")
	f.entry(spec{id: "mx_shared", kind: "pitfall", oneLine: "Keep the shared database pool open for later requests."})
	mustBeEmpty(t, f.send(f.event(contract.PostToolBatch, read(f.file("a.ts", "x"), "x"))))
}
func TestConflictingLiteralsChoosePersonalAndRecordReview(t *testing.T) {
	f := newFixture(t)
	f.entry(spec{id: "mx_teamaa", kind: "rule", oneLine: "Avoid the old helper.", when: []string{"anti:oldCall("}})
	f.entry(spec{id: "mx_person", kind: "pitfall", level: "personal", oneLine: "Use the old helper in this experiment.", when: []string{"required:oldCall("}})
	text := f.send(f.event(contract.PostToolBatch, read(f.file("a.ts", "oldCall("), "oldCall(")))
	mustHave(t, text, "Use the old helper", "Conflicts with mx_teamaa")
	if strings.Contains(text, "Avoid the old helper") {
		t.Fatal(text)
	}
	db, err := sql.Open("sqlite", filepath.Join(f.dir, "hooks.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var n int
	if err = db.QueryRow("SELECT count(*) FROM delivery_conflicts WHERE winner='mx_person' AND loser='mx_teamaa' AND reason='literal'").Scan(&n); err != nil || n != 1 {
		t.Fatal(n, err)
	}
}
func TestSimilarityDoesNotConsumeFullSlots(t *testing.T) {
	a := scored("a", tierFile, "docs", "src/a.ts", 20)
	b := scored("b", tierFile, "docs", "src/a.ts", 20)
	c := scored("c", tierFolder, "docs", "**", 20)
	a.item.Entry.OneLine = "Keep the shared pool open for every request."
	b.item.Entry.OneLine = a.item.Entry.OneLine
	c.item.Entry.OneLine = "Keep generated code changes in the source template."
	a.fullTok, b.fullTok, c.fullTok = 90, 90, 90
	p := pack([]shaped{a, b, c}, nil)
	if p[1].detail != "similar" || p[2].form != "full" {
		t.Fatal(p)
	}
}

// A short entry contained in a longer one must not hide the longer one (OSS-86:
// Hono's five-command CI procedure was withheld after "Lint: `pnpm run lint`").
// The other way round, the short one adds nothing and is withheld.
func TestSimilarityIsDirectional(t *testing.T) {
	ci := "After changes in `adapters/**`, `src/**`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` and `.github/workflows/ci-adapters.yml`, run `pnpm run lint`, `pnpm run build`, `pnpm run build:adapters`, `pnpm run test:adapters` and `pnpm --filter @hono/deno run test:deno` (CI runs them in `.github/workflows/ci-adapters.yml`)."
	lint := "Lint: `pnpm run lint`"
	procedure := &entries.Item{Entry: &entries.Entry{Kind: "procedure", Scope: []string{"adapters/**", "src/**"}, OneLine: ci, Text: ci}}
	recipe := &entries.Item{Entry: &entries.Entry{Kind: "recipe", Scope: []string{"**"}, OneLine: lint, Text: lint}}
	if itemSimilar(procedure, recipe) {
		t.Fatal("the CI procedure was withheld as similar to the lint recipe")
	}
	if !itemSimilar(recipe, procedure) {
		t.Fatal("the lint recipe was not withheld after the CI procedure that covers it")
	}
	if nativeSimilar(ci, []string{"# Checks\nRun `pnpm run lint` before you push.\n"}) {
		t.Fatal("a rule-file line naming one command hid the CI procedure")
	}
	// The rationale doesn't count against coverage, but negations still do.
	never := &entries.Item{Entry: &entries.Entry{Kind: "rule", OneLine: "Never edit the shared database pool settings.", Text: "Never edit the shared database pool settings. It broke prod."}}
	edit := &entries.Item{Entry: &entries.Entry{Kind: "rule", OneLine: "Edit the shared database pool settings.", Text: "Edit the shared database pool settings."}}
	if itemSimilar(edit, never) || itemSimilar(never, edit) {
		t.Fatal("a negation was erased")
	}
}
func TestRendererGoldenAgentFormats(t *testing.T) {
	s := scored("mx_poolaa", tierFile, "docs", "src/a.ts", 19)
	s.full = "[team, from docs] Keep the pool open because all requests share it."
	plan := []planned{{shaped: s, form: "full", text: s.full, tokens: 19}}
	receipts := []record.Receipt{{DeliveryCandidate: record.DeliveryCandidate{EntryID: "mx_poolaa", Action: "given"}}}
	context := render("golden", plan, receipts)
	for _, agent := range []string{"claude-code", "codex"} {
		kind := contract.PostToolBatch
		name := "PostToolBatch"
		if agent == "codex" {
			kind = contract.PostTool
			name = "PostToolUse"
		}
		profile, _ := adapter.Lookup(agent)
		b, dropped := profile.Render(contract.Event{Agent: agent, Kind: kind}, contract.Reply{Context: context})
		expected := "{\"hookSpecificOutput\":{\"hookEventName\":\"" + name + "\",\"additionalContext\":\"[mex golden]\\n[team, from docs] Keep the pool open because all requests share it. (mx_poolaa)\"}}\n"
		path := filepath.Join("testdata", "render-"+agent+".json")
		golden, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if string(golden) != expected || string(b) != expected || len(dropped) != 0 {
			t.Fatalf("%s: %s %v", agent, b, dropped)
		}
	}
}
