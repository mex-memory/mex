package delivery

import (
	"path/filepath"
	"testing"

	"github.com/mex-memory/mex/native/internal/contract"
)

// Index moments stay silent when the file index doesn't cover the checkout,
// even with every rescue surface on: no guess is made from the disk.
func TestIndexMomentsSilentWithoutAnIndex(t *testing.T) {
	f := rescueFixture(t)
	f.file("src/new/client.ts", "export {}\n") // on disk, but never indexed
	env := rescueEnv(f, "on")
	missing := failedRead(filepath.ToSlash(filepath.Join(f.root, "src", "old", "client.ts")), "File does not exist.")
	glob := contract.Tool{Name: contract.ToolGlob, RawName: "Glob", Input: contract.ToolInput{Pattern: "src/**/*.ts"}, Output: &contract.ToolOutput{Text: "Glob timed out after 20 seconds", OK: false}}
	search := grep("getUserById", "No matches found")
	for name, tool := range map[string]contract.Tool{"wrong path": missing, "glob timeout": glob, "empty search": search} {
		f.session += "x"
		ev := f.event(contract.PostToolFailure)
		if name == "empty search" {
			ev = f.event(contract.PostToolBatch, tool)
		} else {
			ev.Tool = &tool
		}
		if out := sendWith(t, ev, env); out != "" {
			t.Fatalf("%s without an index: %q", name, out)
		}
	}
	if rows := surfaceRows(t, f); len(rows) != 0 {
		t.Fatalf("recorded a firing without an index: %v", rows)
	}
}
