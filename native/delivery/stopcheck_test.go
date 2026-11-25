package delivery

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
)

// apiObligation is knowledge-08's CI path obligation for packages/api.
func apiObligation(f *fixture) {
	f.entry(spec{id: "mx_factapi", kind: "procedure", scope: "packages/api/**", evidence: "mined", source: "ci", ref: ".github/workflows/api.yml",
		oneLine: "After changes in `packages/api/**`, run `npm run -w packages/api test` (CI runs it in `.github/workflows/api.yml`).",
		checks: []string{
			"    - kind: key\n      role: complete\n      target: {file: .github/workflows/api.yml, pointer: /on/pull_request/paths}\n      saw: {value: [\"packages/api/**\"]}\n      files: {}\n",
			"    - kind: command\n      role: supporting\n      target: {run: \"npm run -w packages/api test\", file: packages/api/package.json, pointer: /scripts/test}\n      saw: {exists: true}\n      files: {}\n",
		}})
	f.verdict("mx_factapi", held)
}

// journal appends capture rows for the fixture's session.
func (f *fixture) journal(rows ...record.JournalRow) {
	f.t.Helper()
	h, err := record.OpenHooks(record.Location{Directory: f.dir, Hooks: filepath.Join(f.dir, "hooks.db")})
	if err != nil {
		f.t.Fatal(err)
	}
	defer h.Close()
	f.now = f.now.Add(time.Second)
	if err := h.AppendJournal(record.Session{SessionID: f.session, Agent: f.agent, ProjectID: f.project, Checkout: f.root}, f.now.UTC().Format(time.RFC3339Nano), rows); err != nil {
		f.t.Fatal(err)
	}
}

func editRow(rel string) record.JournalRow { return record.JournalRow{Kind: "edit", Text: rel} }

func commandRow(text string, code int) record.JournalRow {
	return record.JournalRow{Kind: "command", Text: text, ExitCode: &code}
}

func stopNow(f *fixture) contract.Reply {
	f.t.Helper()
	return StopChecks(f.event(contract.Stop), f.env())
}

func TestStopSendsBackOnceForAMissedCIObligation(t *testing.T) {
	f := newFixture(t)
	apiObligation(f)
	f.start("startup")
	f.journal(record.JournalRow{Kind: "typed", Text: "add a route"}, editRow("packages/api/src/routes.ts"), commandRow("git status", 0))

	r := stopNow(f)
	if r.Decision != contract.Deny {
		t.Fatalf("missed obligation not sent back: %+v", r)
	}
	for _, want := range []string{"MEX is sending you back once", "`packages/api/src/routes.ts`", "`npm run -w packages/api test`", "`.github/workflows/api.yml`", "(mx_factapi)", "won't send you back for these again"} {
		if !strings.Contains(r.Reason, want) {
			t.Fatalf("reason lacks %q:\n%s", want, r.Reason)
		}
	}
	// The agent's continuation edits there again and still doesn't run it:
	// never twice for one rule in one epoch.
	f.journal(editRow("packages/api/src/other.ts"))
	if r := stopNow(f); r.Decision != "" {
		t.Fatalf("sent back twice: %+v", r)
	}
	// A new epoch (compaction) may send it back once more.
	f.start("compact")
	f.journal(editRow("packages/api/src/third.ts"))
	if r := stopNow(f); r.Decision != contract.Deny {
		t.Fatalf("new epoch: %+v", r)
	}
}

func TestStopObligationSettledByACommandAfterTheLastEdit(t *testing.T) {
	cases := map[string]struct {
		rows []record.JournalRow
		deny bool
	}{
		"ran after the edit":               {rows: []record.JournalRow{editRow("packages/api/a.ts"), commandRow("npm run -w packages/api test", 0)}},
		"failed still counts as ran":       {rows: []record.JournalRow{editRow("packages/api/a.ts"), commandRow("npm run -w packages/api test", 1)}},
		"from inside the package":          {rows: []record.JournalRow{editRow("packages/api/a.ts"), commandRow("cd packages/api && npm test", 0)}},
		"with env prefix and extra args":   {rows: []record.JournalRow{editRow("packages/api/a.ts"), commandRow("CI=1 npm run -w packages/api test -- --run", 0)}},
		"ran before the last edit":         {rows: []record.JournalRow{editRow("packages/api/a.ts"), commandRow("npm run -w packages/api test", 0), editRow("packages/api/b.ts")}, deny: true},
		"a different script":               {rows: []record.JournalRow{editRow("packages/api/a.ts"), commandRow("npm run -w packages/api lint", 0)}, deny: true},
		"edit outside the obligation":      {rows: []record.JournalRow{editRow("packages/web/a.ts")}},
		"a turn with no edits":             {rows: []record.JournalRow{commandRow("ls", 0)}},
		"the obligation's own config file": {rows: []record.JournalRow{editRow("packages/api/package.json")}, deny: true},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t)
			apiObligation(f)
			f.start("startup")
			f.journal(c.rows...)
			if r := stopNow(f); (r.Decision == contract.Deny) != c.deny {
				t.Fatalf("deny=%v, want %v: %+v", r.Decision == contract.Deny, c.deny, r)
			}
		})
	}
}

func TestStopReadsEachTurnOnce(t *testing.T) {
	f := newFixture(t)
	apiObligation(f)
	f.start("startup")
	f.journal(editRow("packages/api/a.ts"), commandRow("npm run -w packages/api test", 0))
	if r := stopNow(f); r.Decision != "" {
		t.Fatalf("obligation met: %+v", r)
	}
	// The next turn only runs a command: no edits, nothing to check, even
	// though the earlier turn's edit is still in the journal.
	f.journal(commandRow("git diff", 0))
	if r := stopNow(f); r.Decision != "" {
		t.Fatalf("a turn without edits: %+v", r)
	}
	// A stop with no new rows at all.
	if r := stopNow(f); r.Decision != "" {
		t.Fatalf("no new rows: %+v", r)
	}
}

func TestStopNeverSendsBackAStopThatIsAlreadyContinuing(t *testing.T) {
	f := newFixture(t)
	apiObligation(f)
	f.start("startup")
	f.journal(editRow("packages/api/a.ts"))
	ev := f.event(contract.Stop)
	ev.StopActive = true
	if r := StopChecks(ev, f.env()); r.Decision != "" {
		t.Fatalf("stop_active: %+v", r)
	}
	// The turn was read: the next stop doesn't revisit it.
	if r := stopNow(f); r.Decision != "" {
		t.Fatalf("turn read again after stop_active: %+v", r)
	}
}

func TestStopSharesTheSpeedBumpBudget(t *testing.T) {
	f := newFixture(t)
	apiObligation(f)
	f.start("startup")
	ev := f.event(contract.Stop)
	file := bumpStatePath(f.dir, ev)
	state := loadBumpState(file, currentEpoch(t, f))
	state.Stopped["mx_factapi"] = true
	if err := state.save(file); err != nil {
		t.Fatal(err)
	}
	f.journal(editRow("packages/api/a.ts"))
	if r := stopNow(f); r.Decision != "" {
		t.Fatalf("a rule already stopped this epoch: %+v", r)
	}
}

func TestStopOnlyForObligationsTheCodeStillSupports(t *testing.T) {
	for name, verdict := range map[string]string{"no verdict yet": "", "broken": broken, "changed": changed} {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t)
			apiObligation(f)
			if verdict == "" {
				db := fixtureHooksDB(t, f.dir)
				if _, err := db.Exec("DELETE FROM verdicts"); err != nil {
					t.Fatal(err)
				}
				_ = db.Close()
			} else {
				f.verdict("mx_factapi", verdict)
			}
			f.start("startup")
			f.journal(editRow("packages/api/a.ts"))
			if r := stopNow(f); r.Decision != "" {
				t.Fatalf("sent back on a %s obligation: %+v", name, r)
			}
		})
	}
}

func TestStopSilentWhereItCanNotKnow(t *testing.T) {
	t.Run("subagent", func(t *testing.T) {
		f := newFixture(t)
		apiObligation(f)
		f.start("startup")
		f.journal(editRow("packages/api/a.ts"))
		ev := f.event(contract.Stop)
		ev.AgentID = "sub-1"
		if r := StopChecks(ev, f.env()); r.Decision != "" {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("no hooks record", func(t *testing.T) {
		f := uninitializedFixture(t)
		apiObligation(f)
		if r := stopNow(f); r.Decision != "" || !r.Empty() {
			t.Fatalf("%+v", r)
		}
	})
	t.Run("not a stop", func(t *testing.T) {
		f := newFixture(t)
		apiObligation(f)
		f.start("startup")
		f.journal(editRow("packages/api/a.ts"))
		if r := StopChecks(f.event(contract.SessionEnd), f.env()); r.Decision != "" {
			t.Fatalf("%+v", r)
		}
	})
}

const (
	stopSourceFile = "packages/api/src/routes.ts"
	stopTestFile   = "packages/api/tests/routes.test.ts"
)

func stopTestFixture(t *testing.T, indexed bool) *fixture {
	t.Helper()
	f := rescueFixture(t)
	if indexed {
		plantStopTestGraph(t, f)
	}
	f.file(stopSourceFile, "export function parseRoute(route: string) {\n  return route.trim();\n}\n")
	f.file(stopTestFile, "import { parseRoute } from '../src/routes';\nfunction testParseRoute() {\n  return parseRoute('/orders');\n}\n")
	f.start("startup")
	return f
}

func plantStopTestGraph(t *testing.T, f *fixture) {
	t.Helper()
	// The edit will leave the source index stale. The test's call is backed
	// by the graph and rechecked against the test file on disk.
	plantIndex(t, f, map[string][]plantedSymbol{stopSourceFile: {{"parseRoute", "function", 1, 3}}})
	dir := index.Directory(f.dir, f.project)
	const base = "graph-base-test.db"
	db, err := sql.Open("sqlite", filepath.Join(dir, base))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	execSQL := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(query, args...); err != nil {
			t.Fatal(err)
		}
	}
	execSQL(`CREATE TABLE files(path TEXT PRIMARY KEY, content_hash TEXT);
CREATE TABLE nodes(id TEXT PRIMARY KEY, name TEXT, file_path TEXT, start_line INT, end_line INT, kind TEXT, is_exported INT, signature TEXT, body_hash TEXT, container_id TEXT);
CREATE TABLE edges(source TEXT, target TEXT, kind TEXT, line INT, resolution_method TEXT);
CREATE TABLE unresolved_refs(reference_name TEXT, from_node_id TEXT, status TEXT, reference_kind TEXT, candidates TEXT, line INT);`)
	execSQL(`INSERT INTO nodes VALUES
		('parseRoute', 'parseRoute', ?, 1, 3, 'function', 1, '', '', NULL),
		('testParseRoute', 'testParseRoute', ?, 2, 4, 'function', 0, '', '', NULL)`, stopSourceFile, stopTestFile)
	execSQL(`INSERT INTO edges VALUES('testParseRoute', 'parseRoute', 'calls', 3, 'explicit-import')`)
	pointer, err := json.Marshal(map[string]any{"version": 1, "root": f.root, "base": base, "as_of": "2026-11-15T00:00:00Z"})
	if err != nil {
		t.Fatal(err)
	}
	checkouts := filepath.Join(dir, "graph-checkouts")
	if err := os.MkdirAll(checkouts, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(checkouts, place.ShortHash(f.root)+".json"), pointer, 0o600); err != nil {
		t.Fatal(err)
	}
}

func stopWithChangedFile(f *fixture, rel string) contract.Reply {
	f.t.Helper()
	env := f.env()
	file := filepath.ToSlash(filepath.Join(f.root, rel))
	env.Changed = ChangedLines{file: {{From: 2, To: 3}}}
	return StopChecks(f.event(contract.Stop), env)
}

func TestStopDirectTests(t *testing.T) {
	edit := editRow(stopSourceFile)
	cases := []struct {
		name    string
		changed string
		rows    []record.JournalRow
		noGraph bool
		deny    bool
	}{
		{name: "no test command", changed: stopSourceFile, rows: []record.JournalRow{edit}, deny: true},
		{name: "full suite after edit", changed: stopSourceFile, rows: []record.JournalRow{edit, commandRow("npm test", 0)}},
		{name: "test path after edit", changed: stopSourceFile, rows: []record.JournalRow{edit, commandRow("npx vitest run "+stopTestFile, 0)}},
		{name: "test base name after edit", changed: stopSourceFile, rows: []record.JournalRow{edit, commandRow("npx vitest run routes.test.ts", 0)}},
		{name: "test folder after edit", changed: stopSourceFile, rows: []record.JournalRow{edit, commandRow("npx vitest run packages/api/tests/", 0)}},
		{name: "test command before last edit", changed: stopSourceFile, rows: []record.JournalRow{edit, commandRow("npm test", 0), edit}, deny: true},
		{name: "only a test file edited", changed: stopTestFile, rows: []record.JournalRow{editRow(stopTestFile)}},
		{name: "no graph or file index", changed: stopSourceFile, rows: []record.JournalRow{edit}, noGraph: true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := stopTestFixture(t, !c.noGraph)
			f.journal(c.rows...)
			r := stopWithChangedFile(f, c.changed)
			if !c.deny {
				if r != (contract.Reply{}) {
					t.Fatalf("want an empty reply, got %+v", r)
				}
				return
			}
			if r.Decision != contract.Deny {
				t.Fatalf("missed direct tests did not deny: %+v", r)
			}
			for _, want := range []string{"`parseRoute`", "`" + stopTestFile + "`", "Run it now"} {
				if !strings.Contains(r.Reason, want) {
					t.Fatalf("reason lacks %q:\n%s", want, r.Reason)
				}
			}
		})
	}
}

func TestStopCIObligationSuppressesDirectTestsForTheSameFile(t *testing.T) {
	f := stopTestFixture(t, true)
	apiObligation(f)
	f.journal(editRow(stopSourceFile))

	r := stopWithChangedFile(f, stopSourceFile)
	if r.Decision != contract.Deny {
		t.Fatalf("missed obligation did not deny: %+v", r)
	}
	if strings.Count(r.Reason, "\n\n- ") != 1 || !strings.Contains(r.Reason, "`npm run -w packages/api test`") ||
		!strings.Contains(r.Reason, "(mx_factapi)") || strings.Contains(r.Reason, stopTestFile) || strings.Contains(r.Reason, "`parseRoute`") {
		t.Fatalf("reason should name only the CI obligation:\n%s", r.Reason)
	}
}

func TestStopDirectTestsSpendOneBudgetPerEpoch(t *testing.T) {
	f := stopTestFixture(t, true)
	f.journal(editRow(stopSourceFile))
	if r := stopWithChangedFile(f, stopSourceFile); r.Decision != contract.Deny {
		t.Fatalf("first turn should deny: %+v", r)
	}
	ev := f.event(contract.Stop)
	state := loadBumpState(bumpStatePath(f.dir, ev), currentEpoch(t, f))
	if !state.Stopped["mex:direct-tests"] {
		t.Fatalf("direct-tests rule was not recorded in the stop budget: %v", state.Stopped)
	}

	f.journal(editRow(stopSourceFile))
	if r := stopWithChangedFile(f, stopSourceFile); r != (contract.Reply{}) {
		t.Fatalf("second turn in the same epoch should be silent: %+v", r)
	}
}

func TestSameCommand(t *testing.T) {
	cases := []struct {
		segment, command string
		want             bool
	}{
		{"npm run -w packages/api test", "npm run -w packages/api test", true},
		{"  npm   run -w packages/api   test ", "npm run -w packages/api test", true},
		{"NODE_ENV=test npm run -w packages/api test", "npm run -w packages/api test", true},
		{"npm test", "npm run -w packages/api test", true},
		{"pnpm --filter api test", "pnpm --filter api run test", true},
		{"yarn workspace api test", "yarn workspace api test", true},
		{"pnpm test", "npm run -w packages/api test", false},
		{"npm run lint", "npm run -w packages/api test", false},
		{"npm run -- test", "npm run -w packages/api test", false},
		{"make test", "make test", true},
		{"make lint", "make test", false},
		{"", "make test", false},
	}
	for _, c := range cases {
		if got := sameCommand(c.segment, c.command); got != c.want {
			t.Errorf("sameCommand(%q, %q) = %v, want %v", c.segment, c.command, got, c.want)
		}
	}
}

func TestNamesAnyTestFile(t *testing.T) {
	tests := []string{"packages/api/test/routes.test.ts"}
	for segment, want := range map[string]bool{
		"":       false,
		"vitest": false,
		"vitest packages/api/test/routes.test.ts": true,
		"vitest ./test/routes.test.ts":            true,
		"vitest routes.test.ts":                   true,
		"vitest packages/api/test":                true,
		"vitest packages/api/test/":               true,
		"vitest packages/web":                     false,
		"vitest --run":                            false,
	} {
		if got := namesAny(segment, tests); got != want {
			t.Errorf("namesAny(%q) = %v, want %v", segment, got, want)
		}
	}
}
