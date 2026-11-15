package delivery

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/internal/gitstate"
	"github.com/mex-memory/mex/native/internal/rulechange"
)

func TestRuleChangeBecomesPointerWithoutRepeatingClaim(t *testing.T) {
	for _, kind := range []string{"rule", "decision", "pitfall"} {
		t.Run(kind, func(t *testing.T) {
			f := newFixture(t)
			f.entry(spec{id: "mx_policy0", kind: kind, oneLine: "The old policy is full text.", checks: []string{fmt.Sprintf("    - kind: source\n      role: supporting\n      target: {file: src/main.ts}\n      saw: {hash: sha256:%s}\n      files: {}\n", strings.Repeat("a", 64))}})
			f.file("src/main.ts", "current code\n")
			head := strings.Repeat("a", 40)
			f.file(".git/HEAD", "ref: refs/heads/work\n")
			f.file(".git/refs/heads/work", head+"\n")
			data, err := os.ReadFile(filepath.Join(f.root, ".mex/learned/mx_policy0.md"))
			if err != nil {
				t.Fatal(err)
			}
			e, err := entries.Parse(data)
			if err != nil {
				t.Fatal(err)
			}
			sum := sha256.Sum256(data)
			h := "sha256:" + hex.EncodeToString(sum[:])
			it := entries.Item{Entry: e, Hash: h, Full: "The secret old policy is full text.", OneLine: e.OneLine, Level: "team"}
			senv := &shapeEnv{checkout: f.root, rulesTried: true, rules: &rulechange.Snapshot{Version: 1, Checkout: f.root, Position: gitstate.Position{Branch: "refs/heads/work", Head: head}, Entries: []rulechange.Signal{{ID: e.ID, EntryHash: h, Reasons: []string{"changed"}}}}}
			got := shape(candidate{item: &it}, held, senv)
			if got.action != "replaced" || !strings.Contains(got.full, "src/main.ts") || strings.Contains(got.full, "secret old policy") {
				t.Fatalf("%#v", got)
			}
			if got := shape(candidate{item: &it}, broken, senv); got.action != "withheld" {
				t.Fatalf("broken: %#v", got)
			}
			f.file(".git/HEAD", "ref: refs/heads/other\n")
			f.file(".git/refs/heads/other", head+"\n")
			if got := shape(candidate{item: &it}, changed, senv); got.action != "given" {
				t.Fatalf("other branch: %#v", got)
			}
		})
	}
}
