package delivery

import (
	"path/filepath"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/internal/contract"
)

func created(f *fixture, rel string) contract.Tool {
	p := f.file(rel, "export {}\n")
	content := "export {}\n"
	return contract.Tool{Name: contract.ToolWrite, RawName: "Write", Input: contract.ToolInput{Path: p, Content: &content},
		Output: &contract.ToolOutput{Text: "File created successfully at: " + p, OK: true}}
}

// A new file gets the nearest existing file of the same kind: the same
// folder and compound extension first, tests only for tests.
func TestSiblingPointerAtFileCreation(t *testing.T) {
	f := rescueFixture(t)
	plantIndex(t, f, map[string][]plantedSymbol{
		"src/api/users.controller.ts": nil, "src/api/users.service.ts": nil,
		"src/api/users.controller.test.ts": nil, "src/api/README.md": nil,
	})
	for _, rel := range []string{"src/api/users.controller.ts", "src/api/users.service.ts", "src/api/users.controller.test.ts"} {
		f.file(rel, "export {}\n")
	}
	out := sendWith(t, f.event(contract.PostToolBatch, created(f, "src/api/orders.controller.ts")), rescueEnv(f, "on"))
	if !strings.Contains(out, "New file src/api/orders.controller.ts. The nearest existing file of the same kind is src/api/users.controller.ts") {
		t.Fatal(out)
	}
	out = sendWith(t, f.event(contract.PostToolBatch, created(f, "src/api/orders.controller.test.ts")), rescueEnv(f, "on"))
	if !strings.Contains(out, "src/api/users.controller.test.ts") {
		t.Fatal("a test file gets a test file:", out)
	}
}

// One folder over, the same name: handlers/orders/index.ts beside
// handlers/users/index.ts.
func TestSiblingPointerOneFolderOver(t *testing.T) {
	f := rescueFixture(t)
	plantIndex(t, f, map[string][]plantedSymbol{"handlers/users/index.ts": nil})
	f.file("handlers/users/index.ts", "export {}\n")
	out := sendWith(t, f.event(contract.PostToolBatch, created(f, "handlers/orders/index.ts")), rescueEnv(f, "on"))
	if !strings.Contains(out, "handlers/users/index.ts") {
		t.Fatal(out)
	}
}

func TestSiblingPointerSilentOnDoubt(t *testing.T) {
	f := rescueFixture(t)
	plantIndex(t, f, map[string][]plantedSymbol{"src/a.ts": nil, "src/b.ts": nil, "docs/x.md": nil})
	f.file("src/a.ts", "x\n")
	f.file("src/b.ts", "x\n")
	cases := map[string]contract.Tool{
		"two equally close":   created(f, "src/zed.ts"),
		"not code":            created(f, "docs/new.md"),
		"nothing of the kind": created(f, "lib/thing.go"),
	}
	edit := created(f, "src/c.ts")
	edit.Output.Text = "The file has been updated."
	edit.Name = contract.ToolEdit
	cases["an edit, not a creation"] = edit
	failed := created(f, "src/d.ts")
	failed.Output.OK = false
	cases["failed"] = failed
	for name, tool := range cases {
		if out := sendWith(t, f.event(contract.PostToolBatch, tool), rescueEnv(f, "on")); strings.Contains(out, "New file") {
			t.Errorf("%s: %s", name, out)
		}
	}
	// No index: silent.
	g := rescueFixture(t)
	if out := sendWith(t, g.event(contract.PostToolBatch, created(g, filepath.ToSlash("src/x.ts"))), rescueEnv(g, "on")); strings.Contains(out, "New file") {
		t.Fatal(out)
	}
}
