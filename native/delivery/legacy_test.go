package delivery

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/check"
)

func TestImportedLegacyFactNeverReachesDeliveryAsVerifiedText(t *testing.T) {
	for _, level := range []string{"team", "personal"} {
		for _, present := range []bool{true, false} {
			f := newFixture(t)
			f.entry(spec{id: "mx_legacy1", level: level, kind: "fact", source: "docs", evidence: "docs", ref: ".mex/context/api.md", oneLine: "The old claim must not be restated.", checks: []string{
				"    - kind: legacy-grounding\n      role: supporting\n      target: {node: 'function:12345678abcdefab', file: src/api.ts}\n      saw: {fingerprint: 'mh2:64:Original_CASE', bodyHash: old-body}\n      files: {}\n",
			}})
			if present {
				f.file("src/api.ts", "export const api = 2")
			}
			file := filepath.Join(f.root, ".mex/learned/mx_legacy1.md")
			if level == "personal" {
				file = filepath.Join(f.home, "projects", f.project, "notes", "mx_legacy1.md")
			}
			data, err := os.ReadFile(file)
			if err != nil {
				t.Fatal(err)
			}
			e, err := check.ParseEntry(data)
			if err != nil {
				t.Fatal(err)
			}
			ev, err := check.NewEvaluator(f.root)
			if err != nil {
				t.Fatal(err)
			}
			result := ev.Evaluate(e)
			ev.Close()
			if result.Verdict != check.Unknown {
				t.Fatalf("legacy evidence was certified: %+v", result)
			}
			text := shapeDirect(t, f, result.Verdict)
			if strings.Contains(text, "old claim") {
				t.Fatalf("unverified claim delivered: %s", text)
			}
			if present && !strings.Contains(text, "src/api.ts") {
				t.Fatalf("missing pointer: %s", text)
			}
			if !present && text != "withheld" {
				t.Fatalf("missing target wasn't withheld: %s", text)
			}
		}
	}
}
