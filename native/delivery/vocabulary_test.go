package delivery

import (
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record"
)

func TestVocabularyAliasEligibilityAndBoundaries(t *testing.T) {
	for alias, want := range map[string]bool{"pool": false, "payout run": true, "Payouts": true, "a b": true, "ab": false, "settle": true} {
		if vocabularyAlias(alias) != want {
			t.Fatal(alias, want)
		}
	}
	text := phraseKey("Fix the  Payout\nRun, then the payout runner and re-payout run_id")
	for phrase, want := range map[string]bool{"payout run": true, "payout runner": true, "the payout": true, "pay": false, "run_id": true, "out run": false, "payout ru": false, "re-payout": true} {
		if phraseIn(text, phrase) != want {
			t.Fatal(phrase, want)
		}
	}
	if phraseIn(phraseKey("payouts run"), "payout run") || phraseIn(phraseKey("xpayout run"), "payout run") {
		t.Fatal("matched inside a word")
	}
}

func vocabularyFixture(t *testing.T, aliases ...string) (*fixture, contract.Event) {
	f := rescueFixture(t)
	f.entry(spec{id: "mx_vocab1", kind: "fact", scope: "src/payout.ts", oneLine: "The run settles nightly.", text: "The run settles nightly through settleBatch, never directly. Secret body sentence.", aliases: aliases})
	plantIndex(t, f, map[string][]plantedSymbol{"src/payout.ts": {{"settleBatch", "function", 3, 9}}, "src/other.ts": {{"duplicateName", "function", 1, 1}}})
	indexedSource(t, f, "src/payout.ts", "// payout\n\nfunction settleBatch() {\n}\n")
	indexedSource(t, f, "src/other.ts", "function duplicateName() {}\n")
	ev := f.event(contract.Prompt)
	return f, ev
}

func TestVocabularyPointerCarriesAnchorsNeverTheBody(t *testing.T) {
	f, ev := vocabularyFixture(t, "payout run")
	env := f.env()
	env.Surfaces = `{"prompt-vocabulary":"on"}`
	// The ranker setting is independent: the aliases aid stays off.
	env.Aids = "off"
	ev.Prompt = &contract.PromptIn{Typed: true, Text: "Why is the Payout  Run late?"}
	reply, err := Handle(ev, env)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"payout run" in this repo:`, "src/payout.ts", "settleBatch (src/payout.ts:3)"} {
		if !strings.Contains(reply.Context, want) {
			t.Fatal(want, reply.Context)
		}
	}
	for _, leak := range []string{"Secret body", "settles nightly", "never directly"} {
		if strings.Contains(reply.Context, leak) {
			t.Fatal("entry text leaked", reply.Context)
		}
	}
	if n := strings.Count(reply.Context, "in this repo:"); n != 1 {
		t.Fatal(n)
	}
}

func TestVocabularySilentWithoutAliasMatchOrVerifiedAnchor(t *testing.T) {
	for _, tc := range []struct{ name, prompt string }{
		{"substring of a longer word", "Why are payout runs late?"},
		{"too short alias word", "Why is the pool late?"},
		{"unrelated", "Investigate the build"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f, ev := vocabularyFixture(t, "payout run", "pool")
			env := f.env()
			env.Surfaces = `{"prompt-vocabulary":"on"}`
			ev.Prompt = &contract.PromptIn{Typed: true, Text: tc.prompt}
			reply, err := Handle(ev, env)
			if err != nil || strings.Contains(reply.Context, "in this repo:") {
				t.Fatal(reply, err)
			}
		})
	}
	t.Run("machine prompt", func(t *testing.T) {
		f, ev := vocabularyFixture(t, "payout run")
		env := f.env()
		env.Surfaces = `{"prompt-vocabulary":"on"}`
		ev.Prompt = &contract.PromptIn{Typed: false, Text: "payout run"}
		reply, err := Handle(ev, env)
		if err != nil || !reply.Empty() {
			t.Fatal(reply, err)
		}
	})
	t.Run("scope and name not in the index", func(t *testing.T) {
		f := rescueFixture(t)
		f.entry(spec{id: "mx_vocab2", kind: "fact", scope: "src/gone.ts", oneLine: "Gone.", text: "See vanishedHelper only.", aliases: []string{"payout run"}})
		plantIndex(t, f, map[string][]plantedSymbol{"src/pool.ts": {}})
		indexedSource(t, f, "src/pool.ts", "x\n")
		env := f.env()
		env.Surfaces = `{"prompt-vocabulary":"on"}`
		ev := f.event(contract.Prompt)
		ev.Prompt = &contract.PromptIn{Typed: true, Text: "payout run"}
		reply, err := Handle(ev, env)
		if err != nil || !reply.Empty() {
			t.Fatal(reply, err)
		}
	})
	t.Run("surface off", func(t *testing.T) {
		f, ev := vocabularyFixture(t, "payout run")
		env := f.env()
		env.Surfaces = `{"prompt-vocabulary":"off"}`
		ev.Prompt = &contract.PromptIn{Typed: true, Text: "payout run"}
		reply, err := Handle(ev, env)
		if err != nil || !reply.Empty() {
			t.Fatal(reply, err)
		}
	})
}

func TestVocabularyGlobScopeAndLimit(t *testing.T) {
	f := rescueFixture(t)
	for i, alias := range []string{"alpha ledger", "beta ledger", "gamma ledger"} {
		f.entry(spec{id: "mx_vocab" + string(rune('a'+i)), kind: "fact", scope: "src/**", oneLine: "Ledger.", text: "A ledger note.", aliases: []string{alias}})
	}
	plantIndex(t, f, map[string][]plantedSymbol{"src/ledger.ts": {}})
	indexedSource(t, f, "src/ledger.ts", "x\n")
	env := f.env()
	env.Surfaces = `{"prompt-vocabulary":"on"}`
	ev := f.event(contract.Prompt)
	ev.Prompt = &contract.PromptIn{Typed: true, Text: "Compare the alpha ledger, beta ledger and gamma ledger"}
	reply, err := Handle(ev, env)
	if err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(reply.Context, "in this repo: src/**"); n != vocabularyLimit {
		t.Fatal(n, reply.Context)
	}
}

func TestVocabularyPointerIsTrialByDefaultAndActedByTouchingItsPaths(t *testing.T) {
	f, ev := vocabularyFixture(t, "payout run")
	ev.Prompt = &contract.PromptIn{Typed: true, Text: "payout run"}
	reply, err := Handle(ev, f.env())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(reply.Context, "in this repo:") {
		t.Fatal("trial surface must not send before its gate qualifies", reply.Context)
	}
	target := record.SurfaceTarget{Paths: []string{"src/payout.ts"}}
	if !record.Acted("prompt-vocabulary", target, record.SurfaceTool{Paths: []string{"src/payout.ts"}, Open: true, Success: true}) {
		t.Fatal("acted")
	}
}
