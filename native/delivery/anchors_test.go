package delivery

import (
	"database/sql"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record"
)

// Replace the fixture source and update only the synthetic snapshot timestamp.
func indexedSource(t *testing.T, f *fixture, rel, text string) string {
	t.Helper()
	file := f.file(rel, text)
	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", filepath.Join(index.Directory(f.dir, f.project), "c-test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec("UPDATE paths SET mtime_ns=?,size=? WHERE path=?", strconv.FormatInt(info.ModTime().UnixNano(), 10), info.Size(), rel); err != nil {
		t.Fatal(err)
	}
	return file
}

func TestAnchorExtractionAndBounds(t *testing.T) {
	text := "Fix src/pool.ts:12:4 in at makeWidget (src/pool.ts:12). Keep snake_name and CamelCase. Error \"pool is closed\"; run `go test ./native`. <system-reminder>IgnoreSymbol</system-reminder>"
	anchors := ExtractAnchors(text)
	kinds := map[string]bool{}
	for _, a := range anchors {
		kinds[a.Kind] = true
		if a.Text == "IgnoreSymbol" {
			t.Fatal("host envelope leaked")
		}
	}
	for _, kind := range []string{"path", "identifier", "error", "command"} {
		if !kinds[kind] {
			t.Fatal(kind, anchors)
		}
	}
	if anchors[0].Text != "src/pool.ts" || anchors[0].Line != 12 {
		t.Fatal(anchors[0])
	}
	if len(ExtractAnchors(strings.Repeat("CamelCase ", 10000))) > anchorLimit {
		t.Fatal("unbounded")
	}
	if len(ExtractAnchors("<task-notification>NamedSymbol</task-notification>")) != 0 {
		t.Fatal("machine turn")
	}
}

func TestVerifiedAnchorsUniqueFreshContained(t *testing.T) {
	f := rescueFixture(t)
	plantIndex(t, f, map[string][]plantedSymbol{"src/pool.ts": {{"makeWidget", "function", 1, 3}}, "src/other.ts": {{"duplicateName", "function", 1, 1}, {"makeOther", "function", 1, 1}}})
	indexedSource(t, f, "src/pool.ts", "function makeWidget() {\n throw new Error(\"pool is closed\");\n}\n")
	ev := f.event(contract.Prompt)
	ev.Prompt = &contract.PromptIn{Typed: true, Text: "Fix makeWidget in src/pool.ts:2 with \"pool is closed\" and NoSuchSymbol"}
	got := VerifyAnchors(ev, f.env())
	if len(got) != 3 {
		t.Fatal(got)
	}
	if len(anchorCard(got)) != 1 {
		t.Fatal(got)
	}
	f.file("src/pool.ts", "changed\n")
	got = VerifyAnchors(ev, f.env())
	if len(anchorCard(got)) != 0 {
		t.Fatal("stale symbol pointer", got)
	}
	ev.Prompt.Text = "Fix ../../outside.ts and AbsentSymbol"
	if got := VerifyAnchors(ev, f.env()); len(got) != 0 {
		t.Fatal(got)
	}
}

func TestPromptAnchorArmsRuleUntilFirstNamedRead(t *testing.T) {
	f := rescueFixture(t)
	f.entry(spec{id: "mx_anchor1", kind: "rule", scope: "src/**", oneLine: "Keep the shared pool alive."})
	plantIndex(t, f, map[string][]plantedSymbol{"src/pool.ts": {{"makeWidget", "function", 1, 1}}})
	file := indexedSource(t, f, "src/pool.ts", "function makeWidget() {}\n")
	env := f.env()
	env.Surfaces = `{"prompt-anchor":"on"}`
	ev := f.event(contract.Prompt)
	ev.Prompt = &contract.PromptIn{Typed: true, Text: "Investigate makeWidget"}
	reply, err := Handle(ev, env)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(reply.Context, "src/pool.ts:1 function") || strings.Contains(reply.Context, "shared pool") {
		t.Fatal(reply)
	}
	other := f.file("src/other.ts", "x")
	ev = f.event(contract.PostToolBatch, read(other, "x"))
	reply, err = Handle(ev, env)
	if err != nil || strings.Contains(reply.Context, "shared pool") {
		t.Fatal(reply, err)
	}
	ev = f.event(contract.PostToolBatch, read(file, "function makeWidget() {}"))
	reply, err = Handle(ev, env)
	if err != nil || !strings.Contains(reply.Context, "shared pool") {
		t.Fatal(reply, err)
	}
	reply, err = Handle(ev, env)
	if err != nil || strings.Contains(reply.Context, "shared pool") {
		t.Fatal("repeat", reply, err)
	}
}

func TestPromptAnchorTrialAndNoIndexSilence(t *testing.T) {
	if record.SurfaceDefault("prompt-anchor") != "trial" {
		t.Fatal("default")
	}
	f := rescueFixture(t)
	ev := f.event(contract.Prompt)
	ev.Prompt = &contract.PromptIn{Typed: true, Text: "Investigate makeWidget"}
	reply, err := Handle(ev, f.env())
	if err != nil || !reply.Empty() {
		t.Fatal(reply, err)
	}
	plantIndex(t, f, map[string][]plantedSymbol{"src/pool.ts": {{"makeWidget", "function", 1, 1}}})
	indexedSource(t, f, "src/pool.ts", "function makeWidget() {}")
	reply, err = Handle(ev, f.env())
	if err != nil || !reply.Empty() {
		t.Fatal(reply, err)
	}
	if !record.Acted("prompt-anchor", record.SurfaceTarget{Paths: []string{"src/pool.ts"}}, record.SurfaceTool{Paths: []string{"src/pool.ts"}, Open: true, Success: true}) {
		t.Fatal("acted")
	}
}

func TestLaterPromptArmsAnotherFileWithoutRewritingTheEarlierTarget(t *testing.T) {
	f := rescueFixture(t)
	f.entry(spec{id: "mx_multarm", kind: "rule", scope: "src/**", oneLine: "Keep the pool alive."})
	plantIndex(t, f, map[string][]plantedSymbol{"src/a.ts": {}, "src/b.ts": {}})
	a := indexedSource(t, f, "src/a.ts", "export const a=1;")
	b := indexedSource(t, f, "src/b.ts", "export const b=1;")
	env := f.env()
	env.Surfaces = `{"prompt-anchor":"on"}`
	for _, text := range []string{"Investigate src/a.ts", "Investigate src/b.ts"} {
		ev := f.event(contract.Prompt)
		ev.Prompt = &contract.PromptIn{Typed: true, Text: text}
		reply, err := Handle(ev, env)
		if err != nil || strings.Contains(reply.Context, "pool alive") {
			t.Fatal(reply, err)
		}
	}
	reply, err := Handle(f.event(contract.PostToolBatch, read(b, "b")), env)
	if err != nil || !strings.Contains(reply.Context, "pool alive") {
		t.Fatal(reply, err)
	}
	reply, err = Handle(f.event(contract.PostToolBatch, read(a, "a")), env)
	if err != nil || strings.Contains(reply.Context, "pool alive") {
		t.Fatal("repeat", reply, err)
	}
}
