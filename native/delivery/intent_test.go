package delivery

import (
	"path/filepath"
	"testing"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record"
)

func (f *fixture) setIntent(intent string) {
	f.t.Helper()
	h, err := record.OpenHooks(record.Location{Hooks: filepath.Join(f.dir, "hooks.db")})
	if err != nil {
		f.t.Fatal(err)
	}
	defer h.Close()
	req := baseRequest(f.event(contract.SessionStart), f.env(), f.project, f.root)
	req.Intent = intent
	if _, err = h.CheckAndMark(req); err != nil {
		f.t.Fatal(err)
	}
}

func TestInvestigatingRuleWaitsUntilWorking(t *testing.T) {
	f := newFixture(t)
	f.entry(spec{id: "mx_waitaa", kind: "rule", scope: "src/**", oneLine: "Use the shared logger.", when: []string{"anti:console.log("}})
	file := f.file("src/a.ts", "console.log(1)")
	mustBeEmpty(t, f.send(f.event(contract.PostToolBatch, read(file, "console.log(1)"))))
	rows := f.rows("action='held-back'")
	if len(rows) != 1 {
		t.Fatal(rows)
	}
	f.setIntent("working")
	mustHave(t, f.send(f.event(contract.PostToolBatch, read(file, "console.log(1)"))), "shared logger")
}

// A rule held while investigating goes out at the first edit in its scope,
// not at an edit elsewhere, and only once.
func TestHeldRuleGoesOutAtAnEditInScope(t *testing.T) {
	f := newFixture(t)
	f.entry(spec{id: "mx_waitab", kind: "rule", scope: "src/**", oneLine: "Use the shared logger.", when: []string{"anti:console.log("}})
	file := f.file("src/a.ts", "console.log(1)")
	other := f.file("docs/notes.md", "x")
	mustBeEmpty(t, f.send(f.event(contract.PostToolBatch, read(file, "console.log(1)"))))
	mustBeEmpty(t, f.send(f.event(contract.PostToolBatch, edit(other, "y"))))
	mustHave(t, f.send(f.event(contract.PostToolBatch, edit(file, "logger.info(1)"))), "shared logger")
	mustBeEmpty(t, f.send(f.event(contract.PostToolBatch, edit(file, "logger.info(2)"))))
}

func TestIntentShortcutsRequireWholeWords(t *testing.T) {
	g := &group{}
	for _, tc := range []struct{ text, want string }{{"Investigate the migration", "investigating"}, {"Migrate this module", "changing"}, {"reproduce a failure", "reproducing"}, {"show reprojection", "investigating"}} {
		ev := contract.Event{Kind: contract.Prompt, Prompt: &contract.PromptIn{Typed: true, Text: tc.text}}
		if got := observeIntent("investigating", ev, g); got != tc.want {
			t.Fatalf("%q: %s", tc.text, got)
		}
	}
}

func TestManifestDependencyIntent(t *testing.T) {
	for _, tc := range []struct {
		name, file, old, next string
		want                  bool
	}{
		{"removed", "package.json", `{"dependencies":{"pool":"1","other":"2"}}`, `{"dependencies":{"other":"2"}}`, true},
		{"section edit", "package.json", `"devDependencies":{"pool":"1"}`, `"devDependencies":{}`, true},
		{"whole section", "package.json", `"dependencies":{"pool":"1"}`, ``, true},
		{"version change", "package.json", `{"dependencies":{"pool":"1"}}`, `{"dependencies":{"pool":"2"}}`, false},
		{"script", "package.json", `{"scripts":{"pool":"test"}}`, `{}`, false},
		{"unproven property", "package.json", `"pool":"1"`, ``, false},
		{"other file", "config.json", `{"dependencies":{"pool":"1"}}`, `{}`, false},
		{"invalid replacement", "package.json", `{"dependencies":{"pool":"1"}}`, `invalid`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v := toolView{name: contract.ToolEdit, rel: tc.file, removed: tc.old, added: tc.next}
			if got := dependencyRemoved(v); got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
			intent := observeIntent("investigating", contract.Event{}, &group{snap: &entries.Snapshot{}, views: []toolView{v}})
			if (intent == "changing") != tc.want {
				t.Fatal(intent)
			}
		})
	}
}
