package delivery

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/internal/contract"
)

// The ticket's demo: a repo whose note says date-fns, and an agent that
// types `import moment`.
func datesRule(f *fixture, extra ...func(*spec)) {
	s := spec{id: "mx_dates1", kind: "rule", scope: "apps/api/**", oneLine: "Dates in the API: date-fns, not moment.js.",
		text: "The API uses date-fns for dates, not moment.js, because moment is no longer maintained and is large.", when: []string{"anti:from 'moment'"}}
	for _, e := range extra {
		e(&s)
	}
	f.entry(s)
}

func preEdit(f *fixture, tool contract.Tool) contract.Reply {
	f.t.Helper()
	return SpeedBump(f.event(contract.PreTool, tool), f.env())
}

func edited(f *fixture, rel, oldText, newText string) contract.Tool {
	p := f.file(rel, oldText+"\n")
	return contract.Tool{Name: contract.ToolEdit, RawName: "Edit", Input: contract.ToolInput{Path: p, Old: &oldText, New: &newText}}
}

func TestSpeedBumpStopsOncePerRulePerEpoch(t *testing.T) {
	f := newFixture(t)
	datesRule(f)
	f.start("startup")
	add := edited(f, "apps/api/dates.ts", "export {}", "import m from 'moment'\nexport {}")

	r := preEdit(f, add)
	if r.Decision != contract.Deny {
		t.Fatalf("first edit not stopped: %+v", r)
	}
	for _, want := range []string{"MEX stopped this edit once", "[team, from a person] The API uses date-fns", "`from 'moment'`", "apps/api/dates.ts", "make the edit again"} {
		if !strings.Contains(r.Reason, want) {
			t.Fatalf("reason lacks %q:\n%s", want, r.Reason)
		}
	}
	// The agent repeats: it passes, and the rule counts as deliberate.
	if r := preEdit(f, add); r.Decision != "" {
		t.Fatalf("a repeat must pass: %+v", r)
	}
	ev := f.event(contract.PreTool, add)
	if !Deliberate(f.dir, ev, currentEpoch(t, f))["mx_dates1"] {
		t.Fatal("going past the bump marks the rule deliberate")
	}
	// Never twice in the same epoch, whatever file.
	other := edited(f, "apps/api/other.ts", "export {}", "import moment from 'moment'")
	if r := preEdit(f, other); r.Decision != "" {
		t.Fatalf("never blocks twice: %+v", r)
	}
	// A new epoch (compaction) may stop it once more.
	f.start("compact")
	if r := preEdit(f, other); r.Decision != contract.Deny {
		t.Fatalf("new epoch: %+v", r)
	}
}

func TestSpeedBumpOnlyWhenTheEditIntroducesThePattern(t *testing.T) {
	f := newFixture(t)
	datesRule(f)
	f.start("startup")
	// The old text already had it: moving an import isn't introducing it.
	if r := preEdit(f, edited(f, "apps/api/a.ts", "import m from 'moment'", "import m from 'moment' // legacy")); r.Decision != "" {
		t.Fatalf("already there: %+v", r)
	}
	// A Write over a file that already had it.
	p := f.file("apps/api/b.ts", "import m from 'moment'\n")
	content := "import m from 'moment'\nexport const x = 1\n"
	if r := preEdit(f, contract.Tool{Name: contract.ToolWrite, RawName: "Write", Input: contract.ToolInput{Path: p, Content: &content}}); r.Decision != "" {
		t.Fatalf("write over a file with it: %+v", r)
	}
	// A Write creating a new file with it is stopped.
	fresh := filepath.ToSlash(filepath.Join(filepath.FromSlash(f.root), "apps", "api", "new.ts"))
	if r := preEdit(f, contract.Tool{Name: contract.ToolWrite, RawName: "Write", Input: contract.ToolInput{Path: fresh, Content: &content}}); r.Decision != contract.Deny {
		t.Fatalf("a new file with it: %+v", r)
	}
}

func TestSpeedBumpNeverForWeakOrOutOfScopeRules(t *testing.T) {
	cases := map[string]struct {
		rule func(*spec)
		rel  string
		prep func(*fixture)
	}{
		"out of scope":     {rel: "apps/web/dates.ts"},
		"mined evidence":   {rule: func(s *spec) { s.evidence, s.source = "mined", "mined" }, rel: "apps/api/x.ts"},
		"a hint":           {rule: func(s *spec) { s.level, s.evidence, s.source = "hint", "observed", "observed" }, rel: "apps/api/x.ts"},
		"a pitfall":        {rule: func(s *spec) { s.kind = "pitfall" }, rel: "apps/api/x.ts"},
		"too short":        {rule: func(s *spec) { s.when = []string{"anti:m("} }, rel: "apps/api/x.ts"},
		"wildcards only":   {rule: func(s *spec) { s.when = []string{"anti:~$A($$$)"} }, rel: "apps/api/x.ts"},
		"a required rule":  {rule: func(s *spec) { s.when = []string{"required:from 'moment'"} }, rel: "apps/api/x.ts"},
		"a broken verdict": {rel: "apps/api/x.ts", prep: func(f *fixture) { f.verdict("mx_dates1", broken) }},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t)
			if c.rule != nil {
				datesRule(f, c.rule)
			} else {
				datesRule(f)
			}
			if c.prep != nil {
				c.prep(f)
			}
			f.start("startup")
			if r := preEdit(f, edited(f, c.rel, "export {}", "import m from 'moment'\nm(1)")); r.Decision != "" {
				t.Fatalf("stopped: %+v", r)
			}
		})
	}
}

func TestSpeedBumpAgentsAndTools(t *testing.T) {
	f := newFixture(t)
	datesRule(f, func(s *spec) { s.when = []string{"anti:~console.log($$$)"} })
	f.start("startup")
	add := edited(f, "apps/api/log.ts", "export {}", "console\n  .log('debug', x)")
	// Reads and shell commands are never stopped.
	if r := preEdit(f, read(add.Input.Path, "")); r.Decision != "" {
		t.Fatal("a read")
	}
	if r := preEdit(f, shell("echo console.log >> apps/api/log.ts", "", true)); r.Decision != "" {
		t.Fatal("a shell command")
	}
	// Agents whose pre-edit hook can't deny with the new text: never.
	f.agent = "copilot"
	if r := preEdit(f, add); r.Decision != "" {
		t.Fatal("copilot")
	}
	// Codex apply_patch, with a structural pattern.
	f.agent, f.session = "codex", "c1"
	f.start("startup")
	patch := contract.Tool{Name: contract.ToolPatch, RawName: "apply_patch", Input: contract.ToolInput{Files: []contract.PatchFile{{Path: add.Input.Path, Kind: "update", Hunks: []contract.Hunk{{Old: "export {}", New: "console.log(x)\nexport {}"}}}}}}
	if r := preEdit(f, patch); r.Decision != contract.Deny || !strings.Contains(r.Reason, "console.log($$$)") {
		t.Fatalf("codex patch: %+v", r)
	}
	// Claude Edit, structural across lines, in its own session.
	f.agent, f.session = "claude-code", "s2"
	f.start("startup")
	if r := preEdit(f, add); r.Decision != contract.Deny {
		t.Fatalf("claude edit: %+v", r)
	}
}

func TestSpeedBumpNeverStopsWhenItCantRecord(t *testing.T) {
	f := newFixture(t)
	datesRule(f)
	f.start("startup")
	// A file where the state folder should be: nothing can be recorded, so
	// a deny could repeat; the edit goes through instead.
	if err := os.WriteFile(filepath.Join(f.dir, "speed-bump"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if r := preEdit(f, edited(f, "apps/api/a.ts", "export {}", "import m from 'moment'")); r.Decision != "" {
		t.Fatalf("unrecordable: %+v", r)
	}
}

func currentEpoch(t *testing.T, f *fixture) int {
	t.Helper()
	db, err := sqlOpen(f)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var n int
	if err := db.QueryRow("SELECT max(epoch) FROM epochs WHERE session_id=? AND agent_id=?", f.session, f.agentID).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

// Going past a bump and making the edit marks the epoch "changing", so the
// rule goes once as the current convention rather than as a missed rule.
func TestSpeedBumpRepeatCountsAsChanging(t *testing.T) {
	f := newFixture(t)
	datesRule(f)
	f.start("startup")
	add := edited(f, "apps/api/dates.ts", "export {}", "import m from 'moment'\nexport {}")
	if r := preEdit(f, add); r.Decision != contract.Deny {
		t.Fatal("not stopped")
	}
	if r := preEdit(f, add); r.Decision != "" {
		t.Fatal("repeat stopped")
	}
	ran := add
	ran.Output = &contract.ToolOutput{Text: "ok", OK: true}
	f.send(f.event(contract.PostToolBatch, ran))
	if got := epochIntent(t, f); got != "changing" {
		t.Fatalf("intent %q", got)
	}
}

func TestSpeedBumpNoRepeatLeavesIntentAlone(t *testing.T) {
	f := newFixture(t)
	datesRule(f)
	f.start("startup")
	add := edited(f, "apps/api/dates.ts", "export {}", "import m from 'moment'\nexport {}")
	ran := add
	ran.Output = &contract.ToolOutput{Text: "ok", OK: true}
	f.send(f.event(contract.PostToolBatch, ran)) // never bumped, never repeated
	if got := epochIntent(t, f); got == "changing" {
		t.Fatalf("intent %q without a bump", got)
	}
}

func epochIntent(t *testing.T, f *fixture) string {
	t.Helper()
	db, err := sqlOpen(f)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var intent string
	if err := db.QueryRow("SELECT intent FROM epochs WHERE session_id=? AND agent_id=? ORDER BY epoch DESC LIMIT 1", f.session, f.agentID).Scan(&intent); err != nil {
		t.Fatal(err)
	}
	return intent
}
