package delivery

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record"
)

// fixture is one checkout with MEX on, its record directory and entries.
type fixture struct {
	t        *testing.T
	root     string // checkout
	home     string // MEX home (personal notes, hints)
	dir      string // record directory
	project  string
	session  string
	agent    string
	agentID  string
	now      time.Time
	resolve  Resolver
	verdicts map[string]string
}

func newFixture(t *testing.T) *fixture {
	t.Helper()
	f := uninitializedFixture(t)
	db := fixtureHooksDB(t, f.dir)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	return f
}

// Keep cold/no-op storage assertions explicit. Behavior fixtures prepare the
// schema outside the 250 ms hook deadline; record tests cover migrations and
// production deadline/fail-open behavior separately.
func uninitializedFixture(t *testing.T) *fixture {
	t.Helper()
	f := &fixture{t: t, root: slash(t.TempDir()), home: t.TempDir(), dir: t.TempDir(), project: "project", session: "s1", agent: "claude-code", now: time.Now(), verdicts: map[string]string{}}
	return f
}

type spec struct {
	id, kind, scope, evidence, oneLine, text string
	when                                     []string // "type:pattern"
	checks                                   []string // raw YAML list items
	companions                               []string
	aliases                                  []string
	level                                    string // team (default), personal, hint
	source                                   string // source type, default person
	ref                                      string
}

func (f *fixture) entry(s spec) {
	f.t.Helper()
	if s.scope == "" {
		s.scope = "**"
	}
	if s.evidence == "" {
		s.evidence = "person"
	}
	if s.source == "" {
		s.source = "person"
	}
	if s.ref == "" {
		s.ref = "typed note"
	}
	if s.text == "" {
		s.text = s.oneLine + " Because the team agreed."
	}
	var b strings.Builder
	fmt.Fprintf(&b, "---\nmex:\n  id: %s\n  kind: %s\n  scope:\n    - %q\n  source:\n    type: %s\n    ref: %q\n", s.id, s.kind, s.scope, s.source, s.ref)
	if s.source == "person" {
		fmt.Fprintf(&b, "    quote: %q\n", s.oneLine)
	}
	fmt.Fprintf(&b, "  evidence: %s\n  one_line: %q\n", s.evidence, s.oneLine)
	if len(s.when) > 0 {
		b.WriteString("  when:\n")
		for _, w := range s.when {
			typ, pat, _ := strings.Cut(w, ":")
			fmt.Fprintf(&b, "    - type: %s\n      match: literal\n      pattern: %q\n", typ, pat)
		}
	}
	if len(s.checks) == 0 {
		b.WriteString("  checks: []\n")
	} else {
		b.WriteString("  checks:\n")
		for _, c := range s.checks {
			b.WriteString(c)
		}
	}
	if len(s.aliases) > 0 {
		b.WriteString("  aliases:\n")
		for _, a := range s.aliases {
			fmt.Fprintf(&b, "    - %q\n", a)
		}
	}
	if len(s.companions) > 0 {
		b.WriteString("  companions:\n")
		for _, c := range s.companions {
			fmt.Fprintf(&b, "    - %s\n", c)
		}
	}
	fmt.Fprintf(&b, "  status: active\n  created: 2026-11-03\n---\n%s\n", s.text)
	var folder string
	switch s.level {
	case "personal":
		folder = filepath.Join(f.home, "projects", f.project, "notes")
	case "hint":
		folder = filepath.Join(f.home, "projects", f.project, "hints")
	default:
		folder = filepath.Join(filepath.FromSlash(f.root), ".mex", "learned")
	}
	if err := os.MkdirAll(folder, 0o700); err != nil {
		f.t.Fatal(err)
	}
	p := filepath.Join(folder, s.id+".md")
	if err := os.WriteFile(p, []byte(b.String()), 0o600); err != nil {
		f.t.Fatal(err)
	}
	past := time.Now().Add(-5 * time.Second)
	_ = os.Chtimes(p, past, past)
}

func (f *fixture) file(rel, content string) string {
	f.t.Helper()
	p := filepath.Join(filepath.FromSlash(f.root), filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o600); err != nil {
		f.t.Fatal(err)
	}
	return slash(p)
}

func fixtureHooksDB(t *testing.T, directory string) *sql.DB {
	t.Helper()
	// Schema preparation is outside hook deadlines, through the real
	// migrations so the fixture can't fall behind them. These tests assert
	// delivery behavior; migration and production lock/deadline tests live in
	// record.
	if err := record.PrepareHooks(record.Location{Directory: directory, Hooks: filepath.Join(directory, "hooks.db")}); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", filepath.Join(directory, "hooks.db"))
	if err != nil {
		t.Fatal(err)
	}
	var version int
	if err = db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != record.SchemaVersion {
		_ = db.Close()
		t.Fatalf("fixture schema %d: %v", version, err)
	}
	return db
}

func (f *fixture) verdict(id, v string) {
	f.t.Helper()
	db := fixtureHooksDB(f.t, f.dir)
	defer db.Close()
	var err error
	if _, err = db.Exec("INSERT INTO verdicts VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,checkout,entry_id) DO UPDATE SET verdict=excluded.verdict,inputs_hash=excluded.inputs_hash,checked_at=excluded.checked_at", f.project, f.root, id, v, "x", "2026-11-14T00:00:00Z"); err != nil {
		f.t.Fatal(err)
	}
}

func (f *fixture) env() Environment {
	return Environment{Home: f.home, RecordDirectory: f.dir, Now: f.now, Resolve: f.resolve}
}

func (f *fixture) event(kind contract.Kind, tools ...contract.Tool) contract.Event {
	ev := contract.Event{Agent: f.agent, Kind: kind, SessionID: f.session, AgentID: f.agentID, Cwd: f.root, ProjectID: f.project, Checkout: f.root}
	if kind == contract.PostToolBatch {
		ev.Batch = tools
	} else if len(tools) > 0 {
		ev.Tool = &tools[0]
	}
	return ev
}

func (f *fixture) send(ev contract.Event) string {
	f.t.Helper()
	reply, err := Handle(ev, f.env())
	if err != nil {
		f.t.Fatal(err)
	}
	return reply.Context
}

func read(path, text string) contract.Tool {
	return contract.Tool{Name: contract.ToolRead, RawName: "Read", Input: contract.ToolInput{Path: path}, Output: &contract.ToolOutput{Text: text, OK: true}}
}

func shell(command, out string, ok bool) contract.Tool {
	code := 0
	if !ok {
		code = 1
	}
	return contract.Tool{Name: contract.ToolShell, RawName: "Bash", Input: contract.ToolInput{Command: command}, Output: &contract.ToolOutput{Text: out, OK: ok, ExitCode: &code}}
}

func edit(path, newText string) contract.Tool {
	old := "x"
	return contract.Tool{Name: contract.ToolEdit, RawName: "Edit", Input: contract.ToolInput{Path: path, Old: &old, New: &newText}, Output: &contract.ToolOutput{Text: "ok", OK: true}}
}

func write(path, content, response string) contract.Tool {
	return contract.Tool{Name: contract.ToolWrite, RawName: "Write", Input: contract.ToolInput{Path: path, Content: &content}, Output: &contract.ToolOutput{Text: response, OK: true}}
}

func (f *fixture) rows(where string) []string {
	f.t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(f.dir, "hooks.db"))
	if err != nil {
		f.t.Fatal(err)
	}
	defer db.Close()
	q := "SELECT entry_id||':'||action||':'||moment||':'||form FROM deliveries"
	if where != "" {
		q += " WHERE " + where
	}
	r, err := db.Query(q + " ORDER BY rowid")
	if err != nil {
		f.t.Fatal(err)
	}
	defer r.Close()
	var out []string
	for r.Next() {
		var s string
		_ = r.Scan(&s)
		out = append(out, s)
	}
	return out
}

func mustHave(t *testing.T, ctx string, wants ...string) {
	t.Helper()
	for _, w := range wants {
		if !strings.Contains(ctx, w) {
			t.Fatalf("context lacks %q:\n%s", w, ctx)
		}
	}
}

func mustBeEmpty(t *testing.T, ctx string) {
	t.Helper()
	if ctx != "" {
		t.Fatalf("expected silence, got:\n%s", ctx)
	}
}

var markerLine = regexp.MustCompile(`^\[mex [0-9a-f]{24}\]\n`)

func TestPitfallOnFirstReadOnce(t *testing.T) {
	f := newFixture(t)
	f.entry(spec{id: "mx_pitfal", kind: "pitfall", scope: "src/db/**", oneLine: "The pool is shared; never close it here."})
	p := f.file("src/db/pool.ts", "export const pool = 1\n")
	other := f.file("src/api/x.ts", "x\n")
	mustBeEmpty(t, f.send(f.event(contract.PostToolBatch, read(other, "x"))))
	ctx := f.send(f.event(contract.PostToolBatch, read(p, "export const pool = 1")))
	if !markerLine.MatchString(ctx) {
		t.Fatalf("missing marker line: %q", ctx)
	}
	mustHave(t, ctx, "never close it here", "(mx_pitfal)", "[team, from a person]")
	mustBeEmpty(t, f.send(f.event(contract.PostToolBatch, read(p, "export const pool = 1"))))
	if got := f.rows(""); len(got) != 2 || got[0] != "mx_pitfal:given:read:full" || got[1] != "mx_pitfal:control:read:one-line" {
		t.Fatal(got)
	}
}

func TestClaudePostToolUseIsSilentBatchDelivers(t *testing.T) {
	f := uninitializedFixture(t)
	f.entry(spec{id: "mx_pitfal", kind: "pitfall", scope: "src/**", oneLine: "Read the README first."})
	p := f.file("src/a.ts", "a\n")
	mustBeEmpty(t, f.send(f.event(contract.PostTool, read(p, "a"))))
	if _, err := os.Stat(filepath.Join(f.dir, "hooks.db")); err == nil {
		t.Fatal("a silent PostToolUse opened hooks.db")
	}
	db := fixtureHooksDB(t, f.dir)
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	f.agent = "codex"
	mustHave(t, f.send(f.event(contract.PostTool, read(p, "a"))), "Read the README first.")
}

func TestRuleNeedsRiskEvidence(t *testing.T) {
	f := newFixture(t)
	f.setIntent("working")
	f.entry(spec{id: "mx_rulelg", kind: "rule", scope: "apps/api/**", oneLine: "Log through src/logger, not console.log.", when: []string{"anti:console.log("}})
	f.entry(spec{id: "mx_rulenp", kind: "rule", scope: "apps/api/**", oneLine: "A rule with no pattern waits."})
	clean := f.file("apps/api/a.ts", "logger.info(1)\n")
	risky := f.file("apps/api/b.ts", "console.log(1)\n")
	mustBeEmpty(t, f.send(f.event(contract.PostToolBatch, read(clean, "logger.info(1)"))))
	ctx := f.send(f.event(contract.PostToolBatch, read(risky, "1\tconsole.log(1)")))
	mustHave(t, ctx, "src/logger")
	if strings.Contains(ctx, "waits") {
		t.Fatal("pattern-less rule was pushed at a read")
	}
}

func TestRecipeOnMatchingCommand(t *testing.T) {
	f := newFixture(t)
	f.file("package.json", `{"scripts":{"test:unit":"vitest run"}}`)
	f.entry(spec{id: "mx_recipe", kind: "recipe", oneLine: "Unit tests: `pnpm test:unit`; set TZ=UTC first.", checks: []string{commandCheck("pnpm test:unit", "test:unit")}})
	mustBeEmpty(t, f.send(f.event(contract.PostToolBatch, shell("pnpm lint", "ok", true))))
	mustBeEmpty(t, f.send(f.event(contract.PostToolBatch, shell("pnpm test", "ok", true))))
	mustHave(t, f.send(f.event(contract.PostToolBatch, shell("TZ=UTC pnpm run test:unit -- --watch=false", "ok", true))), "set TZ=UTC")
	mustBeEmpty(t, f.send(f.event(contract.PostToolBatch, shell("npm run test:unit", "ok", true))))
}

func commandCheck(run, script string) string {
	return fmt.Sprintf("    - kind: command\n      role: complete\n      target: {run: %q, file: package.json, pointer: \"/scripts/%s\"}\n      saw: {exists: true}\n      files: {}\n", run, script)
}

func TestFailureFixExactSignatureOnly(t *testing.T) {
	f := newFixture(t)
	f.entry(spec{id: "mx_fixdb1", kind: "hint", oneLine: "ECONNREFUSED 5432 means the test database is not up: run `docker compose up db`.", when: []string{"anti:connect ECONNREFUSED 127.0.0.1:5432"}})
	near := shell("pnpm test", "Exit code 1\nError: connect ECONNREFUSED 127.0.0.1:6379", false)
	ev := f.event(contract.PostToolFailure, near)
	mustBeEmpty(t, f.send(ev))
	hit := shell("pnpm test", "Exit code 1\nError:   connect ECONNREFUSED 127.0.0.1:5432", false)
	mustHave(t, f.send(f.event(contract.PostToolFailure, hit)), "docker compose up db")
	mustBeEmpty(t, f.send(f.event(contract.PostToolFailure, hit)))
	if got := f.rows("entry_id='mx_fixdb1'"); len(got) != 2 || got[0] != "mx_fixdb1:given:failure:full" || got[1] != "mx_fixdb1:control:failure:one-line" {
		t.Fatal(got)
	}
	// A success never brings a fix.
	f.session = "s2"
	mustBeEmpty(t, f.send(f.event(contract.PostToolBatch, shell("pnpm test", "connect ECONNREFUSED 127.0.0.1:5432 handled", true))))
}

func TestCodexExitHeaderIsAFailure(t *testing.T) {
	f := newFixture(t)
	f.agent = "codex"
	f.entry(spec{id: "mx_fixgo1", kind: "hint", oneLine: "Run `go generate ./...` after editing the schema.", when: []string{"anti:undefined: schema.Generated"}})
	tool := contract.Tool{Name: contract.ToolShell, RawName: "shell", Input: contract.ToolInput{Command: "go build ./..."}, Output: &contract.ToolOutput{Text: "Exit code: 1\n./x.go:3: undefined: schema.Generated", OK: true}}
	mustHave(t, f.send(f.event(contract.PostTool, tool)), "go generate")
}

func TestDecisionWhenRejectedOptionAppears(t *testing.T) {
	f := newFixture(t)
	f.entry(spec{id: "mx_decide", kind: "decision", scope: "apps/api/**", oneLine: "Dates use date-fns, not moment, because moment is unmaintained.", when: []string{"rejected:moment"}})
	p := f.file("apps/api/d.ts", "x\n")
	mustBeEmpty(t, f.send(f.event(contract.PostToolBatch, edit(p, "import { format } from 'date-fns'"))))
	mustHave(t, f.send(f.event(contract.PostToolBatch, edit(p, "import moment from 'moment'"))), "date-fns")
	// The typed prompt names it too: a new session hears it there.
	f.session = "s2"
	ev := f.event(contract.Prompt)
	ev.Prompt = &contract.PromptIn{Text: "switch the API dates to moment please", Typed: true}
	mustHave(t, f.send(ev), "date-fns")
	f.session = "s3"
	ev.SessionID = "s3"
	ev.Prompt = &contract.PromptIn{Text: "the momentum of this work", Typed: true}
	mustBeEmpty(t, f.send(ev))
	ev.Prompt = &contract.PromptIn{Text: "switch to moment", Typed: false}
	mustBeEmpty(t, f.send(ev))
}

func TestProcedureOnCreateOnly(t *testing.T) {
	f := newFixture(t)
	f.entry(spec{id: "mx_proced", kind: "procedure", scope: "migrations/**", oneLine: "New migrations need a down step and an entry in migrations/index.ts.", when: []string{"creates:migrations/*.sql"}})
	p := f.file("migrations/001.sql", "x\n")
	mustBeEmpty(t, f.send(f.event(contract.PostToolBatch, write(p, "y", "The file has been updated successfully."))))
	mustHave(t, f.send(f.event(contract.PostToolBatch, write(slash(filepath.Join(filepath.FromSlash(f.root), "migrations", "002.sql")), "y", "File created successfully at: x"))), "down step")
}

func TestPromptAsksToTest(t *testing.T) {
	f := newFixture(t)
	f.file("package.json", `{"scripts":{"test:unit":"vitest run"}}`)
	f.entry(spec{id: "mx_recipe", kind: "recipe", oneLine: "Unit tests: `pnpm test:unit`.", checks: []string{commandCheck("pnpm test:unit", "test:unit")}})
	ev := f.event(contract.Prompt)
	ev.Prompt = &contract.PromptIn{Text: "fix the parser and run the tests", Typed: true}
	mustHave(t, f.send(ev), "pnpm test:unit")
	ev.SessionID = "s2"
	ev.Prompt = &contract.PromptIn{Text: "explain the parser", Typed: true}
	mustBeEmpty(t, f.send(ev))
}

func TestGeneratedPitfallOnEdit(t *testing.T) {
	f := newFixture(t)
	f.entry(spec{id: "mx_genfil", kind: "pitfall", scope: "src/gen/**", oneLine: "src/gen is generated by `pnpm codegen`; edit the schema instead."})
	f.entry(spec{id: "mx_plainp", kind: "pitfall", scope: "src/gen/**", oneLine: "Large files here are slow to read."})
	p := f.file("src/gen/types.ts", "x\n")
	ctx := f.send(f.event(contract.PostToolBatch, edit(p, "y")))
	mustHave(t, ctx, "edit the schema instead")
	if strings.Contains(ctx, "slow to read") {
		t.Fatal("a plain pitfall fired at an edit")
	}
}

func TestVerdictTable(t *testing.T) {
	type cell struct {
		kind, level, verdict string
		want                 string // "full", "withheld", "pointer", "rederived"
	}
	cells := []cell{}
	for _, k := range []string{"rule", "decision", "pitfall", "procedure"} {
		cells = append(cells, cell{k, "team", held, "full"}, cell{k, "team", changed, "full"}, cell{k, "team", broken, "withheld"}, cell{k, "team", unknown, "full"})
	}
	cells = append(cells,
		cell{"fact", "team", held, "full"}, cell{"fact", "team", changed, "pointer"}, cell{"fact", "team", broken, "withheld"}, cell{"fact", "team", unknown, "pointer"},
		cell{"recipe", "team", held, "full"}, cell{"recipe", "team", changed, "full"}, cell{"recipe", "team", broken, "rederived"}, cell{"recipe", "team", unknown, "full"},
		cell{"hint", "hint", held, "full"}, cell{"hint", "hint", changed, "withheld"}, cell{"hint", "hint", broken, "withheld"}, cell{"hint", "hint", unknown, "full"},
		cell{"rule", "personal", held, "full"}, cell{"rule", "personal", changed, "full"}, cell{"rule", "personal", broken, "withheld"}, cell{"rule", "personal", unknown, "full"},
		// A personal fact follows the code-fact row once its checks say the
		// code changed; not yet evaluated, it is the user's own words.
		cell{"fact", "personal", held, "full"}, cell{"fact", "personal", changed, "pointer"}, cell{"fact", "personal", broken, "withheld"}, cell{"fact", "personal", unknown, "full"},
	)
	for _, c := range cells {
		t.Run(c.kind+"/"+c.level+"/"+c.verdict, func(t *testing.T) {
			f := newFixture(t)
			f.file("package.json", `{"scripts":{"test:unit:ci":"vitest run"}}`)
			f.file("src/cors.ts", "export const defaults = {\n  allowMethods: ['GET'],\n}\n")
			s := spec{id: "mx_target", kind: c.kind, scope: "src/**", oneLine: "The claim in one line.", level: c.level}
			switch c.kind {
			case "fact":
				s.checks = []string{"    - kind: value\n      role: complete\n      target: {file: src/cors.ts, symbol: defaults.allowMethods}\n      saw: {value: [GET]}\n      files: {}\n"}
			case "recipe":
				s.oneLine = "Unit tests: `pnpm test:unit`."
				s.checks = []string{commandCheck("pnpm test:unit", "test:unit")}
				if c.verdict != broken {
					f.file("package.json", `{"scripts":{"test:unit":"vitest run"}}`)
				}
			case "hint":
				s.when = []string{"anti:boom: the build exploded"}
			}
			f.entry(s)
			if c.level == "hint" {
				mirror := HintMirrorPath(f.dir, f.project)
				os.MkdirAll(filepath.Dir(mirror), 0o700)
				os.WriteFile(mirror, []byte(`{"version":1,"agents":{"claude-code":[{"id":"mx_target","expires":"2999-01-01T00:00:00Z"}]}}`), 0o600)
			}
			if c.verdict != unknown {
				f.verdict("mx_target", c.verdict)
			}
			var ev contract.Event
			switch c.kind {
			case "recipe":
				ev = f.event(contract.PostToolBatch, shell("pnpm test:unit", "ok", true))
			case "hint":
				ev = f.event(contract.PostToolFailure, shell("make", "boom: the build exploded", false))
			default:
				// Facts are not pushed at moments yet: reach the verdict
				// table through a direct shape call.
				ev = f.event(contract.PostToolBatch, read(f.file("src/a.ts", "a"), "a"))
			}
			var ctx string
			if c.kind == "recipe" || c.kind == "hint" {
				ctx = f.send(ev)
				if ctx == "" {
					ctx = "withheld"
				}
			} else {
				ctx = shapeDirect(t, f, c.verdict)
			}
			switch c.want {
			case "full":
				if ctx == "withheld" {
					t.Fatal("withheld")
				}
				if !strings.Contains(ctx, "claim in one line") && !strings.Contains(ctx, "Unit tests") {
					t.Fatalf("not the full entry: %q", ctx)
				}
			case "withheld":
				if ctx != "withheld" {
					t.Fatalf("not withheld: %q", ctx)
				}
			case "pointer":
				mustHave(t, ctx, "MEX has a note on `defaults.allowMethods`", "src/cors.ts")
				if strings.Contains(ctx, "claim in one line") {
					t.Fatalf("pointer repeats the stale claim: %q", ctx)
				}
			case "rederived":
				mustHave(t, ctx, "pnpm test:unit:ci")
			}
		})
	}
}

// shapeDirect runs the verdict stage on the only entry and returns the text
// that would be sent, or "withheld".
func shapeDirect(t *testing.T, f *fixture, verdict string) string {
	t.Helper()
	snap, err := entries.Load(f.dir, f.home, f.project, f.root)
	if err != nil || len(snap.Items) != 1 {
		t.Fatal(snap, err)
	}
	s := shape(candidate{item: &snap.Items[0], moment: momentRead, tier: tierFile}, verdict, &shapeEnv{recordDirectory: f.dir, project: f.project, checkout: f.root})
	if s.action == "withheld" {
		return "withheld"
	}
	return s.full
}

func TestWrongRepoNestedAndNoMEX(t *testing.T) {
	outer := newFixture(t)
	outer.entry(spec{id: "mx_outerp", kind: "pitfall", scope: "**", oneLine: "Outer repo pitfall."})
	inner := slash(filepath.Join(filepath.FromSlash(outer.root), "vendor", "inner"))
	os.MkdirAll(filepath.Join(filepath.FromSlash(inner), ".mex", "learned"), 0o700)
	innerFix := &fixture{t: t, root: inner, home: outer.home, dir: outer.dir, project: "inner", now: outer.now}
	innerFix.entry(spec{id: "mx_innerp", kind: "pitfall", scope: "**", oneLine: "Inner repo pitfall."})
	elsewhere := slash(t.TempDir())
	outer.resolve = func(p string, isFile bool) (string, string) {
		switch {
		case strings.HasPrefix(p, inner):
			return "inner", inner
		case strings.HasPrefix(p, outer.root):
			return outer.project, outer.root
		}
		return "", ""
	}
	innerFile := innerFix.file("lib.ts", "x")
	ctx := outer.send(outer.event(contract.PostToolBatch, read(innerFile, "x")))
	mustHave(t, ctx, "Inner repo pitfall.")
	if strings.Contains(ctx, "Outer") {
		t.Fatal("outer entries leaked into the nested repo")
	}
	os.WriteFile(filepath.Join(filepath.FromSlash(elsewhere), "z.ts"), []byte("z"), 0o600)
	mustBeEmpty(t, outer.send(outer.event(contract.PostToolBatch, read(elsewhere+"/z.ts", "z"))))
	// `cd` decides the repo of a command, not the shell's folder.
	innerFix.file("package.json", `{"scripts":{"build":"tsc"}}`)
	innerFix.entry(spec{id: "mx_innerr", kind: "recipe", oneLine: "Build the inner lib with `pnpm build`.", checks: []string{commandCheck("pnpm build", "build")}})
	mustHave(t, outer.send(outer.event(contract.PostToolBatch, shell("cd vendor/inner && pnpm build", "ok", true))), "inner lib")
}

func TestBrokenGivenEarlierGetsOneCorrection(t *testing.T) {
	f := newFixture(t)
	f.entry(spec{id: "mx_pitfal", kind: "pitfall", scope: "src/**", oneLine: "The pool is shared."})
	p := f.file("src/a.ts", "a")
	mustHave(t, f.send(f.event(contract.PostToolBatch, read(p, "a"))), "pool is shared")
	f.verdict("mx_pitfal", broken)
	q := f.file("src/b.ts", "b")
	ctx := f.send(f.event(contract.PostToolBatch, read(q, "b")))
	mustHave(t, ctx, "Correction: the MEX note mx_pitfal")
	if strings.Contains(ctx, "pool is shared") {
		t.Fatal("broken text resent")
	}
	mustBeEmpty(t, f.send(f.event(contract.PostToolBatch, read(q, "b"))))
	// A broken entry never given before gets no correction, only a log row.
	f.session = "s2"
	mustBeEmpty(t, f.send(f.event(contract.PostToolBatch, read(q, "b"))))
	if got := f.rows("session_id='s2'"); len(got) != 1 || !strings.HasPrefix(got[0], "mx_pitfal:withheld:") {
		t.Fatal(got)
	}
}

func TestBudgetRisingBarAndExemptions(t *testing.T) {
	f := newFixture(t)
	long := strings.Repeat("word ", 300)
	for i := 0; i < 40; i++ {
		f.entry(spec{id: fmt.Sprintf("mx_pf%04d", i), kind: "procedure", scope: fmt.Sprintf("src/f%d.ts", i), evidence: "mined", source: "docs", oneLine: fmt.Sprintf("Pitfall %d short form.", i), text: fmt.Sprintf("Pitfall %d. %s", i, long)})
	}
	sent := 0
	for i := 0; i < 40; i++ {
		ctx := f.send(f.event(contract.PostToolBatch, write(f.file(fmt.Sprintf("src/f%d.ts", i), "x"), "x", `{"type":"create"}`)))
		if ctx != "" {
			sent++
		}
	}
	if sent == 0 || sent >= 40 {
		t.Fatalf("rising bar sent %d of 40", sent)
	}
	held := f.rows("action='held-back'")
	if len(held) == 0 {
		t.Fatal("no hold-back was logged")
	}
	// An exact failure fix still goes out past the budget.
	f.entry(spec{id: "mx_fixlat", kind: "hint", oneLine: "Restart the watcher.", when: []string{"anti:watcher crashed: ENOSPC"}})
	mustHave(t, f.send(f.event(contract.PostToolFailure, shell("pnpm dev", "watcher crashed: ENOSPC", false))), "Restart the watcher")
	db, _ := sql.Open("sqlite", filepath.Join(f.dir, "hooks.db"))
	defer db.Close()
	var tokens, budget int
	db.QueryRow("SELECT tokens_sent,budget FROM epochs WHERE session_id='s1'").Scan(&tokens, &budget)
	if tokens > budget {
		t.Fatalf("main budget overrun: %d > %d", tokens, budget)
	}
}

func TestOneMomentFullFormsUnderTarget(t *testing.T) {
	f := newFixture(t)
	f.entry(spec{id: "mx_aaaaaa", kind: "pitfall", scope: "src/x.ts", oneLine: "First, file-specific.", text: "First, file-specific, with its reason."})
	f.entry(spec{id: "mx_bbbbbb", kind: "pitfall", scope: "src/**", oneLine: "Second, folder-wide.", text: "Second, folder-wide, with its long reason."})
	ctx := f.send(f.event(contract.PostToolBatch, read(f.file("src/x.ts", "x"), "x")))
	mustHave(t, ctx, "with its reason", "Second, folder-wide,")
	if !strings.Contains(ctx, "long reason") {
		t.Fatal("second item lost full form under target")
	}
	if strings.Index(ctx, "First") > strings.Index(ctx, "Second") {
		t.Fatal("file-specific item not first")
	}
}

func TestCompanionsTravel(t *testing.T) {
	f := newFixture(t)
	f.entry(spec{id: "mx_mainpf", kind: "pitfall", scope: "src/x.ts", oneLine: "Main pitfall.", companions: []string{"mx_compan"}})
	f.entry(spec{id: "mx_compan", kind: "rule", scope: "lib/**", oneLine: "Its companion rule."})
	mustHave(t, f.send(f.event(contract.PostToolBatch, read(f.file("src/x.ts", "x"), "x"))), "Main pitfall.", "Its companion rule.")
}

func TestNativeCoverageSkips(t *testing.T) {
	f := newFixture(t)
	f.file("CLAUDE.md", "# Rules\n<!-- mex:mx_shared -->\nShared rule text.\n")
	f.entry(spec{id: "mx_shared", kind: "pitfall", scope: "**", oneLine: "Shared through CLAUDE.md."})
	f.entry(spec{id: "mx_rfile1", kind: "pitfall", scope: "**", oneLine: "Read from CLAUDE.md.", source: "rule-file", ref: "CLAUDE.md#Rules"})
	f.entry(spec{id: "mx_agents", kind: "pitfall", scope: "**", oneLine: "Read from AGENTS.md.", source: "rule-file", ref: "AGENTS.md#Rules"})
	f.file("AGENTS.md", "# Rules\n")
	ctx := f.send(f.event(contract.PostToolBatch, read(f.file("a.ts", "a"), "a")))
	mustHave(t, ctx, "Read from AGENTS.md.")
	if strings.Contains(ctx, "Shared through") || strings.Contains(ctx, "Read from CLAUDE.md") {
		t.Fatalf("natively loaded entries resent: %s", ctx)
	}
	// Codex loads AGENTS.md, not CLAUDE.md.
	f.agent, f.session = "codex", "s2"
	ctx = f.send(f.event(contract.PostTool, read(f.file("a.ts", "a"), "a")))
	mustHave(t, ctx, "Read from CLAUDE.md.", "Shared through CLAUDE.md.")
	if strings.Contains(ctx, "Read from AGENTS.md") {
		t.Fatal("AGENTS.md entry resent to Codex")
	}
}

func TestHintNeedsMirror(t *testing.T) {
	f := newFixture(t)
	f.entry(spec{id: "mx_hint01", kind: "hint", level: "hint", oneLine: "Seen once: retry the flaky upload.", when: []string{"anti:upload timed out after 30s"}, source: "agent-memory", evidence: "observed"})
	fail := f.event(contract.PostToolFailure, shell("pnpm e2e", "upload timed out after 30s", false))
	mirror := HintMirrorPath(f.dir, f.project)
	os.MkdirAll(filepath.Dir(mirror), 0o700)
	os.WriteFile(mirror, []byte(`{"version":1,"agents":{"codex":[{"id":"mx_hint01","expires":"2999-01-01T00:00:00Z"}]}}`), 0o600)
	// An observed hint has no checks (verdict unknown): the mirror vouches.
	f.agent, f.session = "codex", "s0"
	mustHave(t, f.send(f.event(contract.PostToolFailure, shell("pnpm e2e", "upload timed out after 30s", false))), "retry the flaky upload")
	// A check that doubts it still withholds it.
	f.verdict("mx_hint01", changed)
	f.session = "s9"
	mustBeEmpty(t, f.send(f.event(contract.PostToolFailure, shell("pnpm e2e", "upload timed out after 30s", false))))
	f.verdict("mx_hint01", held)
	f.agent, f.session = "claude-code", "s1"
	mustBeEmpty(t, f.send(fail))
	os.WriteFile(mirror, []byte(`{"version":1,"agents":{"codex":[{"id":"mx_hint01","expires":"2999-01-01T00:00:00Z"}],"claude-code":[{"id":"mx_hint01","expires":"2000-01-01T00:00:00Z"}]}}`), 0o600)
	mustBeEmpty(t, f.send(fail))
	f.agent, f.session = "codex", "s2"
	mustHave(t, f.send(f.event(contract.PostToolFailure, shell("pnpm e2e", "upload timed out after 30s", false))), "retry the flaky upload")
}

func TestNoWarningsOrClockTimesInText(t *testing.T) {
	f := newFixture(t)
	f.setIntent("working")
	f.file("package.json", `{"scripts":{"build":"tsc"}}`)
	f.entry(spec{id: "mx_pitfal", kind: "pitfall", scope: "**", oneLine: "Pitfall."})
	f.entry(spec{id: "mx_recipe", kind: "recipe", oneLine: "Build: `pnpm build`.", checks: []string{commandCheck("pnpm build", "build")}})
	f.entry(spec{id: "mx_person", kind: "rule", level: "personal", scope: "**", oneLine: "I prefer small commits.", when: []string{"anti:TODO"}})
	ctx := f.send(f.event(contract.PostToolBatch, read(f.file("a.ts", "TODO"), "TODO"), shell("pnpm build", "", true)))
	mustHave(t, ctx, "Pitfall.", "pnpm build", "small commits")
	for _, bad := range []*regexp.Regexp{regexp.MustCompile(`(?i)verify|warning|⚠|stale|may be out of date`), regexp.MustCompile(`\d{1,2}:\d{2}`)} {
		if bad.MatchString(ctx) {
			t.Fatalf("%s found in %q", bad, ctx)
		}
	}
}

func TestRecipeRederivation(t *testing.T) {
	cases := []struct {
		name, root, workspace, want string
	}{
		{"renamed", `{"scripts":{"test:unit:ci":"vitest run","lint":"eslint"}}`, "", "pnpm test:unit:ci"},
		{"moved to a workspace", `{"scripts":{"lint":"eslint"}}`, `{"scripts":{"test:unit":"vitest run"}}`, "cd packages/core && pnpm test:unit"},
		{"gone", `{"scripts":{"lint":"eslint","build":"tsc"}}`, "", ""},
		{"ambiguous", `{"scripts":{"test:unit:a":"x","test:unit:b":"y"}}`, "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFixture(t)
			f.file("package.json", c.root)
			if c.workspace != "" {
				f.file("packages/core/package.json", c.workspace)
			}
			f.entry(spec{id: "mx_recipe", kind: "recipe", oneLine: "Unit tests: `pnpm test:unit`.", checks: []string{commandCheck("pnpm test:unit", "test:unit")}})
			f.verdict("mx_recipe", broken)
			ctx := f.send(f.event(contract.PostToolBatch, shell("pnpm test:unit", "missing script", true)))
			if c.want == "" {
				mustBeEmpty(t, ctx)
				return
			}
			mustHave(t, ctx, c.want)
			if got := f.rows(""); len(got) != 1 || !strings.Contains(got[0], ":replaced:") {
				t.Fatal(got)
			}
		})
	}
}

func TestFailOpen(t *testing.T) {
	setup := func(t *testing.T) (*fixture, contract.Event) {
		f := newFixture(t)
		f.entry(spec{id: "mx_pitfal", kind: "pitfall", scope: "**", oneLine: "Pitfall."})
		return f, f.event(contract.PostToolBatch, read(f.file("a.ts", "a"), "a"))
	}
	t.Run("corrupt hooks.db", func(t *testing.T) {
		f, ev := setup(t)
		os.WriteFile(filepath.Join(f.dir, "hooks.db"), []byte("not a database, just text that is long enough to look like a header......"), 0o600)
		if reply, err := Handle(ev, f.env()); err == nil && reply.Context != "" {
			t.Fatal("delivered through a corrupt ledger")
		}
	})
	t.Run("locked hooks.db", func(t *testing.T) {
		f, ev := setup(t)
		f.send(f.event(contract.SessionStart))
		db, err := sql.Open("sqlite", filepath.Join(f.dir, "hooks.db"))
		if err != nil {
			t.Fatal(err)
		}
		defer db.Close()
		conn, _ := db.Conn(t.Context())
		defer conn.Close()
		if _, err := conn.ExecContext(t.Context(), "BEGIN IMMEDIATE"); err != nil {
			t.Fatal(err)
		}
		start := time.Now()
		reply, err := Handle(ev, f.env())
		if err == nil || reply.Context != "" {
			t.Fatalf("a locked ledger must refuse, got %q %v", reply.Context, err)
		}
		if d := time.Since(start); d > 2*time.Second {
			t.Fatalf("waited %s on a locked ledger", d)
		}
		conn.ExecContext(t.Context(), "ROLLBACK")
		mustHave(t, f.send(ev), "Pitfall.")
	})
	t.Run("corrupt snapshot files", func(t *testing.T) {
		f, ev := setup(t)
		f.send(f.event(contract.PostToolBatch, read(f.file("b.ts", "b"), "b")))
		matches, _ := filepath.Glob(filepath.Join(f.dir, "delivery-entries", "*"))
		if len(matches) < 2 {
			t.Fatal("snapshot files missing", matches)
		}
		for _, m := range matches {
			os.WriteFile(m, []byte("garbage"), 0o600)
		}
		f.session = "s2"
		ev.SessionID = "s2"
		mustHave(t, f.send(ev), "Pitfall.")
	})
	t.Run("invalid entry file is skipped", func(t *testing.T) {
		f, ev := setup(t)
		os.WriteFile(filepath.Join(filepath.FromSlash(f.root), ".mex", "learned", "mx_broken.md"), []byte("---\nmex: [\n---\n"), 0o600)
		mustHave(t, f.send(ev), "Pitfall.")
	})
}

// Codex 0.165 sends shell output with no exit status. The exact signature
// then counts, unless the command only reads or searches files.
func TestFixWithNoExitStatus(t *testing.T) {
	f := newFixture(t)
	f.agent = "codex"
	f.entry(spec{id: "mx_fixdb2", kind: "hint", oneLine: "Start the test database with docker compose.", when: []string{"anti:connect ECONNREFUSED 127.0.0.1:5432"}})
	noExit := func(command, out string) contract.Tool {
		return contract.Tool{Name: contract.ToolShell, RawName: "Bash", Input: contract.ToolInput{Command: command}, Output: &contract.ToolOutput{Text: out, OK: true}}
	}
	mustBeEmpty(t, f.send(f.event(contract.PostTool, noExit("cat logs/test.log", "Error: connect ECONNREFUSED 127.0.0.1:5432"))))
	mustBeEmpty(t, f.send(f.event(contract.PostTool, noExit("rg ECONNREFUSED logs", "logs/a: connect ECONNREFUSED 127.0.0.1:5432"))))
	mustHave(t, f.send(f.event(contract.PostTool, noExit("node fail.js", "Error: connect ECONNREFUSED 127.0.0.1:5432"))), "docker compose")
}

// The agent reports a path through a link (a symlinked checkout, or /var on
// macOS) while the checkout is registered by its real path.
func TestPathThroughALink(t *testing.T) {
	f := newFixture(t)
	f.entry(spec{id: "mx_linkpf", kind: "pitfall", scope: "src/**", oneLine: "Linked path pitfall."})
	f.file("src/a.ts", "a")
	link := filepath.Join(t.TempDir(), "linked")
	if err := os.Symlink(filepath.FromSlash(f.root), link); err != nil {
		t.Skip("symlinks unavailable:", err)
	}
	f.resolve = func(string, bool) (string, string) { return f.project, f.root }
	mustHave(t, f.send(f.event(contract.PostToolBatch, read(slash(filepath.Join(link, "src", "a.ts")), "a"))), "Linked path pitfall.")
	// A file that doesn't exist yet is placed by its folder.
	if r, ok := relTo(f.root, slash(filepath.Join(link, "src", "new.ts"))); !ok || r != "src/new.ts" {
		t.Fatal(r, ok)
	}
}

func TestPathThroughAnInsideLinkCannotEscapeCheckout(t *testing.T) {
	f := newFixture(t)
	outside := t.TempDir()
	link := filepath.Join(filepath.FromSlash(f.root), "outside")
	if err := os.Symlink(outside, link); err != nil {
		t.Skip("symlinks unavailable:", err)
	}
	if err := os.WriteFile(filepath.Join(outside, "a.ts"), []byte("outside"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"a.ts", "new.ts"} {
		if r, ok := relTo(f.root, filepath.Join(link, name)); ok {
			t.Fatal("accepted an outside target", r)
		}
	}
}

// Claude Code reads no AGENTS.md while a CLAUDE.md sits at the root (its
// default), so a generated area AGENTS.md does not cover Claude there.
func TestRootClaudeFileMeansClaudeReadsNoAgentsFile(t *testing.T) {
	f := newFixture(t)
	f.file("src/gen/AGENTS.md", "# Gen\n- Edit schema.graphql, not this folder. <!-- mex:mx_genpit -->\n")
	f.entry(spec{id: "mx_genpit", kind: "pitfall", scope: "src/gen/**", oneLine: "Edit schema.graphql, not this folder."})
	// No CLAUDE.md anywhere: Claude reads src/gen/AGENTS.md itself.
	mustBeEmpty(t, f.send(f.event(contract.PostToolBatch, read(f.file("src/gen/a.ts", "a"), "a"))))
	f.file("CLAUDE.md", "# Ours\n")
	f.session = "s2"
	mustHave(t, f.send(f.event(contract.PostToolBatch, read(f.file("src/gen/b.ts", "b"), "b"))), "Edit schema.graphql")
}
