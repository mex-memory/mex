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
	for _, want := range []string{"MEX stopped this edit once", "[team, from a person] The API uses date-fns", "`from 'moment'`", "apps/api/dates.ts", "Change the edit to follow it, unless the person asked for exactly this", "make the edit again"} {
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

func TestSpeedBumpSeesAPatternPastThePrefixOfALargeWrite(t *testing.T) {
	f := newFixture(t)
	datesRule(f)
	f.start("startup")
	// Farther down than the prefix a hunk is bounded to, in a file the bump still reads.
	old := strings.Repeat("x", 40<<10)
	p := f.file("apps/api/big.ts", old+"\n")
	content := old + "\nimport m from 'moment'\n"
	r := preEdit(f, contract.Tool{Name: contract.ToolWrite, RawName: "Write", Input: contract.ToolInput{Path: p, Content: &content}})
	if r.Decision != contract.Deny {
		t.Fatalf("a pattern added past the prefix of a large write was not stopped: %+v", r)
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
	// Any agent's edit tool: the hook passes only agents whose profile can
	// deny a tool (see internal/hook), so delivery doesn't filter by name.
	f.agent, f.session = "copilot", "cp1"
	f.start("startup")
	if r := preEdit(f, add); r.Decision != contract.Deny {
		t.Fatalf("copilot: %+v", r)
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

// The speed bump's own cost on a pre-edit, in process (no process start):
// an edit no rule cares about, and one that is stopped. Run with
// go test ./delivery/ -run ^$ -bench SpeedBump.
func BenchmarkSpeedBump(b *testing.B) {
	t := &testing.T{}
	f := newFixture(t)
	f.t = t
	datesRule(f)
	for i := 0; i < 50; i++ { // a repo with more rules than the demo
		f.entry(spec{id: "mx_other" + strings.Repeat("a", 1) + string(rune('a'+i%26)) + string(rune('a'+i/26)), kind: "rule", scope: "src/**", oneLine: "Another rule.", when: []string{"anti:legacyCall("}})
	}
	f.start("startup")
	quiet := edited(f, "apps/api/q.ts", "export {}", "export const x = 1")
	stop := edited(f, "apps/api/s.ts", "export {}", "import m from 'moment'")
	b.Run("no-rule-matches", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			SpeedBump(f.event(contract.PreTool, quiet), f.env())
		}
	})
	b.Run("stopped", func(b *testing.B) {
		for i := 0; i < b.N; i++ {
			f.session = "bench" + strings.Repeat("x", i%3) + string(rune('a'+i%26))
			SpeedBump(f.event(contract.PreTool, stop), f.env())
		}
	})
}

// One stop names every rule an edit breaks, so making the edit again never
// meets a second stop for the other rule.
func TestSpeedBumpOneStopForEveryRuleTheEditBreaks(t *testing.T) {
	f := newFixture(t)
	datesRule(f)
	f.entry(spec{id: "mx_logs01", kind: "rule", scope: "apps/api/**", oneLine: "No console.log in the API; use the logger.", when: []string{"anti:console.log("}})
	f.start("startup")
	add := edited(f, "apps/api/dates.ts", "export {}", "import m from 'moment'\nconsole.log(m())\nexport {}")
	r := preEdit(f, add)
	if r.Decision != contract.Deny || !strings.Contains(r.Reason, "date-fns") || !strings.Contains(r.Reason, "logger") {
		t.Fatalf("one stop for both rules: %+v", r)
	}
	if strings.Count(r.Reason, "MEX stopped this edit once") != 1 || strings.Count(r.Reason, "make the edit again") != 1 || !strings.Contains(r.Reason, "follow them") {
		t.Fatalf("one message, not two:\n%s", r.Reason)
	}
	if r := preEdit(f, add); r.Decision != "" {
		t.Fatalf("the repeat met a second stop: %+v", r)
	}
	ev := f.event(contract.PreTool, add)
	if d := Deliberate(f.dir, ev, currentEpoch(t, f)); !d["mx_dates1"] || !d["mx_logs01"] {
		t.Fatalf("both rules deliberate after the repeat: %v", d)
	}
}

// An edit that brings back what a decision rejected is stopped too, in the
// decision's scope or in a manifest, where a dependency comes back.
func TestSpeedBumpRejectedDecision(t *testing.T) {
	f := newFixture(t)
	f.entry(spec{id: "mx_orm001", kind: "decision", scope: "apps/api/**", oneLine: "We chose Drizzle over Prisma for the API.",
		text: "The API uses Drizzle, not Prisma: Prisma's engine binary broke the Lambda builds.", when: []string{"rejected:\"prisma\""}})
	f.start("startup")
	manifest := edited(f, "package.json", "{\n  \"dependencies\": {}\n}", "{\n  \"dependencies\": {\"prisma\": \"^6\"}\n}")
	r := preEdit(f, manifest)
	if r.Decision != contract.Deny || !strings.Contains(r.Reason, "Drizzle") || !strings.Contains(r.Reason, "brings back a rejected option") {
		t.Fatalf("rejected option in a manifest: %+v", r)
	}
	// Outside the scope and not a manifest: never.
	g := newFixture(t)
	g.entry(spec{id: "mx_orm001", kind: "decision", scope: "apps/api/**", oneLine: "Drizzle over Prisma.", when: []string{"rejected:\"prisma\""}})
	g.start("startup")
	if r := preEdit(g, edited(g, "docs/notes.md", "x", "x \"prisma\" y")); r.Decision != "" {
		t.Fatalf("out of scope: %+v", r)
	}
}

// A mined rule (a layer rule found in the code) stops an edit only while a
// complete check holds: the code agrees with it in full today.
func TestSpeedBumpMinedRuleNeedsAHeldCompleteCheck(t *testing.T) {
	mined := func(s *spec) {
		s.evidence, s.source = "mined", "mined"
		s.checks = []string{"    - kind: value\n      role: complete\n      target: {file: apps/api/dates.ts, symbol: x}\n      saw: {value: 1}\n      files: {}\n"}
	}
	f := newFixture(t)
	datesRule(f, mined)
	f.start("startup")
	add := edited(f, "apps/api/dates.ts", "export {}", "import m from 'moment'")
	if r := preEdit(f, add); r.Decision != "" {
		t.Fatalf("no verdict yet: %+v", r)
	}
	f.verdict("mx_dates1", "held")
	if r := preEdit(f, add); r.Decision != contract.Deny {
		t.Fatalf("held complete check: %+v", r)
	}
	// A supporting check alone isn't enough.
	g := newFixture(t)
	datesRule(g, mined, func(s *spec) { s.checks = []string{strings.Replace(s.checks[0], "complete", "supporting", 1)} })
	g.verdict("mx_dates1", "held")
	g.start("startup")
	if r := preEdit(g, edited(g, "apps/api/dates.ts", "export {}", "import m from 'moment'")); r.Decision != "" {
		t.Fatalf("supporting check only: %+v", r)
	}
}

// Added means more uses after the edit than before: editing a line that
// already had the pattern never stops, adding a second use does.
func TestSpeedBumpCountsUses(t *testing.T) {
	f := newFixture(t)
	datesRule(f)
	f.start("startup")
	if r := preEdit(f, edited(f, "apps/api/a.ts", "import m from 'moment'\nm()", "import m from 'moment'\nm(1)")); r.Decision != "" {
		t.Fatalf("same uses: %+v", r)
	}
	if r := preEdit(f, edited(f, "apps/api/b.ts", "import m from 'moment'", "import m from 'moment'\nimport n from 'moment'")); r.Decision != contract.Deny {
		t.Fatalf("a second use: %+v", r)
	}
}

// A layer rule mined for a folder reached by relative paths is held by an
// import relation, not a literal: an edit inside its scope that adds an
// import resolving into the banned folder is stopped once, whatever the
// relative path looks like from the edited file.
func TestSpeedBumpImportRelation(t *testing.T) {
	layer := func(f *fixture) {
		f.entry(spec{id: "mx_layer1", kind: "rule", scope: "core/**", evidence: "mined", source: "mined",
			oneLine: "`core` never imports `app`; keep the dependency one-way.",
			text:    "`core` never imports `app`: 3 imports go from `app` into `core` and none go back.",
			checks:  []string{"    - kind: relation\n      role: complete\n      target: {query: imports, from: \"core/**\", to: \"app/**\"}\n      saw: {count: 0}\n      files: {}\n"}})
		f.verdict("mx_layer1", "held")
		f.start("startup")
	}
	f := newFixture(t)
	layer(f)
	for name, c := range map[string]struct{ rel, before, after string }{
		"a package import":           {"core/a.ts", "export {}", "import x from 'app'"},
		"an import within the scope": {"core/a.ts", "export {}", "import { b } from './b'"},
		"an import already there":    {"core/a.ts", "import { m } from '../app/m'", "import { m } from '../app/m'\nexport const n = m"},
		"outside the rule's scope":   {"lib/a.ts", "export {}", "import { m } from '../app/m'"},
	} {
		if r := preEdit(f, edited(f, c.rel, c.before, c.after)); r.Decision != "" {
			t.Fatalf("%s: stopped: %+v", name, r)
		}
	}
	r := preEdit(f, edited(f, "core/deep/a.ts", "export {}", "import { m } from '../../app/m'"))
	if r.Decision != contract.Deny || !strings.Contains(r.Reason, "`core` never imports `app`") || !strings.Contains(r.Reason, "`../../app/m` is added in core/deep/a.ts") {
		t.Fatalf("an import into app: %+v", r)
	}
	// Once per rule per epoch: making the edit again passes.
	if r := preEdit(f, edited(f, "core/deep/a.ts", "export {}", "import { m } from '../../app/m'")); r.Decision != "" {
		t.Fatalf("stopped twice: %+v", r)
	}
	g := newFixture(t)
	layer(g)
	if r := preEdit(g, edited(g, "core/a.ts", "export {}", "const m = require(\"../app\")")); r.Decision != contract.Deny {
		t.Fatalf("a require of the folder: %+v", r)
	}
}
