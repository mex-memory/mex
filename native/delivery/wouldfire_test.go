package delivery

import (
	"testing"

	"github.com/mex-memory/mex/native/delivery/entries"
)

const learnedRule = `---
mex:
  id: mx_deepaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  kind: rule
  scope: ["src/api/**"]
  source: {type: review, ref: "https://github.com/acme/app/pull/1", producer: learn-deeper}
  evidence: review
  one_line: Log through apiLogger in the API.
  when:
    - {type: anti, match: literal, pattern: "console.log("}
  checks:
    - {kind: scope, role: complete, target: {glob: "src/api/**"}, saw: {count: 1}, files: {}}
  status: proposed
  created: 2026-11-23
---
Log through apiLogger in the API, not console.log.
`

func TestWouldFireUsesTheSpeedBumpMatching(t *testing.T) {
	it, err := entries.ItemFromFile([]byte(learnedRule), "personal")
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	edits := []WouldFireEdit{
		{Commit: "c1", Path: "src/api/users.ts", Added: "  console.log(user)\n"},                                  // adds it in scope
		{Commit: "c1", Path: "src/api/orders.ts", Added: "  console.log(order)\n"},                                // same rule, same commit: once
		{Commit: "c2", Path: "src/web/page.ts", Added: "  console.log(page)\n"},                                   // out of scope
		{Commit: "c3", Path: "src/api/a.ts", Added: "  console.log(a) // moved\n", Removed: "  console.log(a)\n"}, // adds nothing new
		{Commit: "c4", Path: "src/api/b.ts", Added: "  apiLogger.info(b)\n", Removed: "  console.log(b)\n"},       // the fix
	}
	got := WouldFire([]*entries.Item{it}, edits)
	if len(got) != 1 || got[0].Commit != "c1" || got[0].Path != "src/api/users.ts" || got[0].Pattern != "console.log(" || got[0].Type != "anti" {
		t.Fatalf("matches: %+v", got)
	}
	if WouldFire(nil, edits) != nil {
		t.Fatal("no rules, no matches")
	}
}
