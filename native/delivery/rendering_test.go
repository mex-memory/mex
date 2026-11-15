package delivery

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

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
