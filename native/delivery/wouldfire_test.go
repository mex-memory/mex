package delivery

import (
	"strings"
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

func TestWouldFirePrioritizesStopsAndShowsScopedProseOnce(t *testing.T) {
	parse := func(raw string) *entries.Item {
		t.Helper()
		item, err := entries.ItemFromFile([]byte(raw), "personal")
		if err != nil {
			t.Fatal(err)
		}
		return item
	}
	prose := func(id, scope string) *entries.Item {
		raw := strings.ReplaceAll(learnedRule, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", strings.Repeat(id, 32))
		raw = strings.ReplaceAll(raw, "src/api/**", scope)
		raw = strings.ReplaceAll(raw, "  when:\n    - {type: anti, match: literal, pattern: \"console.log(\"}\n", "")
		return parse(raw)
	}
	broad := prose("b", "**")
	scoped := prose("c", "src/api/**")
	more := prose("d", "src/api/**")
	last := prose("e", "src/api/**")
	items := []*entries.Item{broad, scoped, more, last, parse(learnedRule)}
	edits := []WouldFireEdit{
		{Commit: "new", Path: "src/web/page.ts", Added: "unrelated()"},
		{Commit: "new", Path: "src/api/users.ts", Removed: "removeUnused()"},
		{Commit: "new", Path: "src/api/orders.ts", Added: "updateOrder()"},
		{Commit: "old", Path: "src/api/legacy.ts", Added: "console.log(order)"},
	}
	got := WouldFire(items, edits)
	if len(got) != 3 || got[0].Type != "anti" || got[0].Commit != "old" {
		t.Fatalf("edit stop must precede the prose examples: %+v", got)
	}
	for i, item := range []*entries.Item{scoped, more} {
		match := got[i+1]
		if match.Entry != item.Entry.ID || match.Type != "anchor-touch" || match.Path != "src/api/users.ts" || match.Pattern != "" {
			t.Fatalf("expected one first in-scope touch per rule: %+v", got)
		}
	}
}
