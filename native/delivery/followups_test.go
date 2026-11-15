package delivery

import (
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record"
)

func hold(t *testing.T, f *fixture, ids ...string) {
	t.Helper()
	h, err := record.OpenHooks(record.Location{Hooks: filepath.Join(f.dir, "hooks.db")})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	req := baseRequest(f.event(contract.PostToolBatch), f.env(), f.project, f.root)
	for _, id := range ids {
		req.Candidates = append(req.Candidates, record.DeliveryCandidate{EntryID: id, Action: "held-back", Moment: "read", Form: "one-line"})
	}
	if _, err = h.CheckAndMark(req); err != nil {
		t.Fatal(err)
	}
}
func followKinds(t *testing.T, f *fixture) map[string]int {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(f.dir, "hooks.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	rows, err := db.Query("SELECT d.entry_id||':'||f.kind FROM followups f JOIN deliveries d ON d.id=f.delivery_id")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var s string
		if err = rows.Scan(&s); err != nil {
			t.Fatal(err)
		}
		out[s]++
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	return out
}
func TestControllerHoldbackObservationsAndLaterDelivery(t *testing.T) {
	f := newFixture(t)
	f.file("package.json", `{"scripts":{"test:unit":"runner"}}`)
	f.entry(spec{id: "mx_ruleaa", kind: "rule", scope: "src/**", oneLine: "Use the new function.", when: []string{"anti:oldCall("}})
	f.entry(spec{id: "mx_recipe", kind: "recipe", oneLine: "Unit tests.", checks: []string{commandCheck("npm run test:unit", "test:unit")}})
	f.entry(spec{id: "mx_fixaaa", kind: "hint", oneLine: "Start the service.", when: []string{"anti:service unavailable"}})
	hold(t, f, "mx_ruleaa", "mx_recipe", "mx_fixaaa")
	p := f.file("src/a.ts", "x")
	// An edit of an entry-covered file already opens the record for epoch_files,
	// even though this rule has no edit moment until the edit-check lane lands.
	mustBeEmpty(t, f.send(f.event(contract.PostToolBatch, edit(p, "oldCall("))))
	f.send(f.event(contract.PostToolBatch, shell("npm run test:unit", "ok", true)))
	f.send(f.event(contract.PostToolFailure, shell("make integration", "service unavailable", false)))
	kinds := followKinds(t, f)
	for _, key := range []string{"mx_ruleaa:missed", "mx_recipe:command", "mx_recipe:delivered-later", "mx_fixaaa:failure", "mx_fixaaa:delivered-later"} {
		if kinds[key] != 1 {
			t.Fatal(key, kinds)
		}
	}
	// A later read moment sends the held rule; repeating it doesn't add rows.
	f.send(f.event(contract.PostToolBatch, read(p, "oldCall(")))
	f.send(f.event(contract.PostToolBatch, read(p, "oldCall(")))
	if followKinds(t, f)["mx_ruleaa:delivered-later"] != 1 {
		t.Fatal(followKinds(t, f))
	}
}
func TestFCFSUsesBudgetWithoutExactExemptions(t *testing.T) {
	for _, name := range []string{"tiers", "bm25", "fcfs", "risk"} {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t)
			f.entry(spec{id: "mx_ruleaa", kind: "rule", scope: "src/**", oneLine: "Use the new function.", when: []string{"anti:oldCall("}})
			h, err := record.OpenHooks(record.Location{Hooks: filepath.Join(f.dir, "hooks.db")})
			if err != nil {
				t.Fatal(err)
			}
			req := baseRequest(f.event(contract.SessionStart), f.env(), f.project, f.root)
			req.Budget = 1
			req.Intent = "working"
			if _, err = h.CheckAndMark(req); err != nil {
				t.Fatal(err)
			}
			h.Close()
			env := f.env()
			env.Scorer = name
			reply, err := Handle(f.event(contract.PostToolBatch, read(f.file("src/a.ts", "oldCall("), "oldCall(")), env)
			if err != nil {
				t.Fatal(err)
			}
			if name == "fcfs" {
				if !reply.Empty() {
					t.Fatal("FCFS bypassed budget", reply)
				}
				if len(f.rows("action='held-back'")) != 1 {
					t.Fatal(f.rows(""))
				}
			} else if reply.Empty() {
				t.Fatal("exact match lost exemption")
			}
		})
	}
}
func TestControllerClosesHoldbacksAtEpochEnd(t *testing.T) {
	f := newFixture(t)
	hold(t, f, "mx_ruleaa")
	mustBeEmpty(t, f.send(f.event(contract.PostCompact)))
	kinds := followKinds(t, f)
	if kinds["mx_ruleaa:nothing"] != 1 {
		t.Fatal(kinds)
	}
	hold(t, f, "mx_rulebb")
	mustBeEmpty(t, f.send(f.event(contract.SessionEnd)))
	if followKinds(t, f)["mx_rulebb:nothing"] != 1 {
		t.Fatal(followKinds(t, f))
	}
}
