package delivery

import (
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record"
)

func spanFixture(t *testing.T) (*fixture, string) {
	f := rescueFixture(t)
	plantIndex(t, f, map[string][]plantedSymbol{"src/pool.ts": {{"makeWidget", "function", 1, 3}}})
	return f, indexedSource(t, f, "src/pool.ts", "function makeWidget() {\n return sharedPool;\n}\n")
}

func TestDefinitionPatternShapes(t *testing.T) {
	for pattern, want := range map[string]string{"makeWidget": "makeWidget", "func MakeWidget": "MakeWidget", "^class Widget": "Widget", "def make_widget(": "make_widget", "type Widget =": "Widget", "interface Widget": "Widget", "Widget =": "Widget", "export async function makeWidget(": "makeWidget", `\bmakeWidget\b`: "makeWidget", "make.*Widget": "", "class (Foo|Bar)": "", "foo bar": ""} {
		if got := DefinitionName(pattern); got != want {
			t.Fatalf("%q: %q want %q", pattern, got, want)
		}
	}
}

func TestSearchSpanFreshUniqueInlineAndAlreadyReturned(t *testing.T) {
	f, _ := spanFixture(t)
	ev := f.event(contract.PostToolBatch, grep("makeWidget", "src/pool.ts:1:function makeWidget() {"))
	spans := StudySpans(ev, f.env())
	if len(spans) != 1 || !strings.Contains(spans[0].Text, "return sharedPool") || len(spans[0].Text) > 600 {
		t.Fatal(spans)
	}
	ev.Batch[0].Output.Text = "src/pool.ts:1:function makeWidget() {\nsrc/pool.ts:2: return sharedPool;\nsrc/pool.ts:3:}"
	if got := StudySpans(ev, f.env()); len(got) != 0 {
		t.Fatal("already returned", got)
	}
	f.file("src/pool.ts", "changed")
	if got := StudySpans(ev, f.env()); len(got) != 0 {
		t.Fatal("stale", got)
	}
}

func TestSearchSpanCollisionsAndUsefulSignature(t *testing.T) {
	f, _ := spanFixture(t)
	indexedSource(t, f, "src/pool.ts", "function makeWidget() {\n"+strings.Repeat("x", 900)+"\n}\n")
	ev := f.event(contract.PostToolBatch, grep("makeWidget", "src/pool.ts"))
	got := StudySpans(ev, f.env())
	if len(got) != 1 || !got[0].SignatureOnly || strings.Contains(got[0].Text, strings.Repeat("x", 20)) {
		t.Fatal(got)
	}
	ev.Batch[0].Output.Text = "src/pool.ts:1:function makeWidget() {"
	if got := StudySpans(ev, f.env()); len(got) != 0 {
		t.Fatal("signature already returned", got)
	}
	g := rescueFixture(t)
	plantIndex(t, g, map[string][]plantedSymbol{"a.ts": {{"makeWidget", "function", 1, 1}}, "b.ts": {{"makeWidget", "function", 1, 1}}})
	indexedSource(t, g, "a.ts", "function makeWidget() {}")
	g.file("b.ts", "stale")
	if got := StudySpans(g.event(contract.PostToolBatch, grep("makeWidget", "a.ts")), g.env()); len(got) != 0 {
		t.Fatal("stale collision", got)
	}
}

func TestSearchSpanAdaptersTrialAndBatchDedupe(t *testing.T) {
	f, _ := spanFixture(t)
	ev := f.event(contract.PostTool, grep("makeWidget", "src/pool.ts:1:function makeWidget() {"))
	env := f.env()
	env.Surfaces = `{"search-span":"on"}`
	reply, err := Handle(ev, env)
	if err != nil || !strings.Contains(reply.Context, "return sharedPool;") {
		t.Fatal(reply, err)
	}
	batch := f.event(contract.PostToolBatch, *ev.Tool)
	reply, err = Handle(batch, env)
	if err != nil || reply.Context != "" {
		t.Fatal("duplicate", reply, err)
	}
	g, _ := spanFixture(t)
	ev = g.event(contract.PostToolBatch, grep("makeWidget", "src/pool.ts"))
	reply, err = Handle(ev, g.env())
	if err != nil || reply.Context != "" || record.SurfaceDefault("search-span") != "trial" {
		t.Fatal("trial", reply, err)
	}
	f.agent = "codex"
	ev = f.event(contract.PostTool, shell(`rg -n "function makeWidget" src`, "src/pool.ts:1:function makeWidget() {", true))
	if got := StudySpans(ev, f.env()); len(got) != 1 {
		t.Fatal("shell span", got)
	}
}

func TestSpanStudyIgnoresNonSearchShell(t *testing.T) {
	f, _ := spanFixture(t)
	for _, command := range []string{"npm test", "", "go build ./..."} {
		if got := StudySpans(f.event(contract.PostToolBatch, shell(command, "ok", true)), f.env()); len(got) != 0 {
			t.Fatal(got)
		}
	}
}

func TestSearchSpanAbstainsWhenDuplicateCheckExceedsBound(t *testing.T) {
	f, _ := spanFixture(t)
	ev := f.event(contract.PostToolBatch, grep("makeWidget", strings.Repeat("x", (1<<20)+1)))
	if got := StudySpans(ev, f.env()); len(got) != 0 {
		t.Fatal(got)
	}
}
