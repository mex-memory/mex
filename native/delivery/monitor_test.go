package delivery

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/internal/contract"
)

func TestPatternMonitorWindowAndDemotion(t *testing.T) {
	now := time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC)
	m := &PatternMonitor{Version: 1, Entries: map[string]*PatternActivity{}}
	for i := 0; i < digestFirings-1; i++ {
		m.note("mx_a", true, false, now)
	}
	if m.demoted("mx_a", now) {
		t.Fatal("demoted before it fired often")
	}
	m.note("mx_a", true, false, now)
	if !m.demoted("mx_a", now) {
		t.Fatal("fires often, never broken: demoted")
	}
	m.note("mx_a", false, true, now)
	if m.demoted("mx_a", now) || m.Entries["mx_a"].LastViolation != "2026-11-19" {
		t.Fatal("a violation keeps it out of the digest")
	}
	// A new window starts the counts again.
	later := now.Add(monitorWindow + 24*time.Hour)
	m.note("mx_a", true, false, later)
	if a := m.Entries["mx_a"]; a.Fired != 1 || a.Violations != 0 || a.Window != "2026-12-20" || a.LastFired != "2026-12-20" {
		t.Fatalf("window: %+v", a)
	}
	if m.demoted("mx_b", now) {
		t.Fatal("unknown entry")
	}
}

func readRisk(f *fixture, rel, text string) contract.Tool {
	return read(f.file(rel, text), text)
}

// working: a harmless edit in the same batch, so the session is past
// "investigating" (rules are held back while a session only reads).
func working(f *fixture, tools ...contract.Tool) contract.Event {
	return f.event(contract.PostToolBatch, append([]contract.Tool{editDone(f, "apps/api/z.ts", "export const z = 1")}, tools...)...)
}

func TestFiringsAreCountedAndDemoteToTheDigest(t *testing.T) {
	f := newFixture(t)
	f.entry(spec{id: "mx_errors", kind: "rule", scope: "apps/api/**", oneLine: "API errors go through `httpError`, never a bare throw.",
		text: "API errors go through httpError so the client gets a typed body; a bare throw sends a 500 with no body.", when: []string{"anti:throw new Error("}})
	env := f.env()
	env.Surfaces = "on"
	code := "export function f() { throw new Error('x') }\n"
	// Each session reads code that already has the pattern: it fires, and
	// nobody breaks the rule.
	for i := 0; i < digestFirings; i++ {
		f.session = fmt.Sprintf("s%d", i)
		out := sendWith(t, working(f, readRisk(f, "apps/api/a.ts", code)), env)
		if !strings.Contains(out, "typed body") {
			t.Fatalf("firing %d not sent in full: %q", i, out)
		}
	}
	m := loadMonitor(f.dir, f.project)
	if a := m.Entries["mx_errors"]; a == nil || a.Fired != digestFirings || a.Violations != 0 {
		t.Fatalf("counts: %+v", a)
	}
	// Now it fires often with no violation: the next session gets it as one
	// digest line instead of the full read-risk item.
	f.session = "digest"
	out := sendWith(t, working(f, readRisk(f, "apps/api/b.ts", code)), env)
	if !strings.Contains(out, "`httpError`, never a bare throw") || strings.Contains(out, "typed body") {
		t.Fatalf("not demoted to a digest line: %q", out)
	}
	if got := f.rows("session_id='digest'"); len(got) != 1 || !strings.Contains(got[0], ":given:digest:") {
		t.Fatalf("ledger: %v", got)
	}
	// An edit that adds the anti-pattern is a violation: out of the digest.
	f.session = "broke"
	f.send(f.event(contract.PostToolBatch, editDone(f, "apps/api/c.ts", "throw new Error('y')")))
	if loadMonitor(f.dir, f.project).demoted("mx_errors", time.Now()) {
		t.Fatal("a violation must end the demotion")
	}
}

func TestDigestStaysWithinItsTokens(t *testing.T) {
	f := newFixture(t)
	m := &PatternMonitor{Version: 1, Entries: map[string]*PatternActivity{}}
	now := time.Now()
	for i := 0; i < 20; i++ {
		id := fmt.Sprintf("mx_rule%02d", i)
		f.entry(spec{id: id, kind: "rule", scope: "apps/api/**", oneLine: fmt.Sprintf("Rule %d of the API: keep handlers small and typed, and log through the shared logger always.", i), when: []string{"anti:legacy" + id}})
		for j := 0; j < digestFirings; j++ {
			m.note(id, true, false, now)
		}
	}
	if err := m.save(f.dir, f.project); err != nil {
		t.Fatal(err)
	}
	env := f.env()
	env.Surfaces = "on"
	f.setIntent("working")
	sendWith(t, f.event(contract.PostToolBatch, readRisk(f, "apps/api/a.ts", "export {}\n")), env)
	db, err := sqlOpen(f)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var n, tokens int
	if err := db.QueryRow("SELECT count(*), coalesce(sum(tokens),0) FROM deliveries WHERE moment='digest' AND action='given'").Scan(&n, &tokens); err != nil {
		t.Fatal(err)
	}
	if n == 0 || n == 20 || tokens > digestTokens {
		t.Fatalf("digest: %d items, %d tokens (cap %d)", n, tokens, digestTokens)
	}
}

func TestSpeedBumpStopIsAViolation(t *testing.T) {
	f := newFixture(t)
	datesRule(f)
	f.start("startup")
	if r := preEdit(f, edited(f, "apps/api/dates.ts", "export {}", "import m from 'moment'")); r.Decision != contract.Deny {
		t.Fatal("not stopped")
	}
	if a := loadMonitor(f.dir, f.project).Entries["mx_dates1"]; a == nil || a.Violations != 1 || a.Window == "0001-01-01" {
		t.Fatalf("violation not recorded: %+v", a)
	}
}
