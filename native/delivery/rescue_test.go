package delivery

import (
	"database/sql"
	"encoding/json"
	"os"
	"path"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record/place"
)

type plantedSymbol struct {
	name, kind string
	start, end int
}

// plantIndex writes a minimal file index for the fixture's checkout, in the
// same layout and schema the Node indexer writes.
func plantIndex(t *testing.T, f *fixture, files map[string][]plantedSymbol) {
	t.Helper()
	real, err := place.RealPath(f.root)
	if err != nil {
		t.Fatal(err)
	}
	dir := index.Directory(f.dir, f.project)
	if err = os.MkdirAll(filepath.Join(dir, "checkouts"), 0o700); err != nil {
		t.Fatal(err)
	}
	tables := `CREATE TABLE records(hash TEXT NOT NULL, lang TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(hash, lang)) WITHOUT ROWID;
CREATE TABLE symbols(name TEXT NOT NULL, hash TEXT NOT NULL, lang TEXT NOT NULL, ord INTEGER NOT NULL, kind TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, PRIMARY KEY(name, hash, lang, ord)) WITHOUT ROWID;
CREATE TABLE counts(hash TEXT NOT NULL, lang TEXT NOT NULL, pattern TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(hash, lang, pattern)) WITHOUT ROWID;
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;`
	open := func(name string) *sql.DB {
		db, err := sql.Open("sqlite", filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		if _, err = db.Exec(tables); err != nil {
			t.Fatal(err)
		}
		return db
	}
	base := open("base-test.db")
	base.Close()
	snap := open("c-test.db")
	defer snap.Close()
	if _, err = snap.Exec(`CREATE TABLE paths(path TEXT PRIMARY KEY, hash TEXT, lang TEXT, is_test INTEGER NOT NULL, size INTEGER NOT NULL, mtime_ns TEXT NOT NULL, reason TEXT, name TEXT NOT NULL) WITHOUT ROWID`); err != nil {
		t.Fatal(err)
	}
	for file, symbols := range files {
		f.file(file, "x\n")
		hash := "h-" + file
		if _, err = snap.Exec(`INSERT INTO paths VALUES(?,?,?,0,2,'0',NULL,?)`, file, hash, "ts", path.Base(file)); err != nil {
			t.Fatal(err)
		}
		if _, err = snap.Exec(`INSERT INTO records VALUES(?,?,?)`, hash, "ts", `{"outline":[],"imports":[],"exports":[],"names":[],"patterns":{},"tokens":1,"lines":1}`); err != nil {
			t.Fatal(err)
		}
		for i, s := range symbols {
			if _, err = snap.Exec(`INSERT INTO symbols VALUES(?,?,?,?,?,?,?)`, s.name, hash, "ts", i, s.kind, s.start, s.end); err != nil {
				t.Fatal(err)
			}
		}
	}
	pointer, _ := json.Marshal(index.Pointer{Version: index.StoreVersion, Root: real, Snapshot: "c-test.db", Base: "base-test.db", AsOf: "2026-11-15T00:00:00Z"})
	if err = os.WriteFile(filepath.Join(dir, "checkouts", place.ShortHash(real)+".json"), pointer, 0o600); err != nil {
		t.Fatal(err)
	}
}

// rescueFixture uses the canonical checkout path, as hook events carry it.
func rescueFixture(t *testing.T) *fixture {
	t.Helper()
	f := newFixture(t)
	real, err := place.RealPath(f.root)
	if err != nil {
		t.Fatal(err)
	}
	f.root = real
	return f
}

func rescueEnv(f *fixture, mode string) Environment {
	env := f.env()
	env.Surfaces = mode
	return env
}

func failedRead(p, text string) contract.Tool {
	return contract.Tool{Name: contract.ToolRead, RawName: "Read", Input: contract.ToolInput{Path: p}, Output: &contract.ToolOutput{Text: text, OK: false}}
}

func grep(pattern, out string) contract.Tool {
	return contract.Tool{Name: contract.ToolSearch, RawName: "Grep", Input: contract.ToolInput{Pattern: pattern}, Output: &contract.ToolOutput{Text: out, OK: true}}
}

func surfaceRows(t *testing.T, f *fixture) []string {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(f.dir, "hooks.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	rows, err := db.Query(`SELECT surface||':'||action FROM deliveries WHERE moment='rescue' ORDER BY rowid`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var s string
		rows.Scan(&s)
		out = append(out, s)
	}
	return out
}

func sendWith(t *testing.T, ev contract.Event, env Environment) string {
	t.Helper()
	reply, err := Handle(ev, env)
	if err != nil {
		t.Fatal(err)
	}
	return reply.Context
}

func TestWrongPathRescue(t *testing.T) {
	f := rescueFixture(t)
	plantIndex(t, f, map[string][]plantedSymbol{"src/new/client.ts": nil, "docs/readme.md": nil})
	missing := filepath.ToSlash(filepath.Join(f.root, "src", "old", "client.ts"))
	ev := f.event(contract.PostToolFailure, failedRead(missing, "File does not exist."))
	out := sendWith(t, ev, rescueEnv(f, "on"))
	if !strings.Contains(out, "No file at src/old/client.ts. Indexed files with that name: src/new/client.ts") {
		t.Fatal(out)
	}
	if got := strings.Join(surfaceRows(t, f), ","); got != "rescue-wrong-path:given" {
		t.Fatal(got)
	}
	// The same suggestion isn't repeated in the epoch.
	if out := sendWith(t, ev, rescueEnv(f, "on")); out != "" {
		t.Fatal("repeated", out)
	}
}

func TestWrongPathRescueStaysSilentOnDoubt(t *testing.T) {
	f := rescueFixture(t)
	plantIndex(t, f, map[string][]plantedSymbol{"a/x/util.ts": nil, "b/x/util.ts": nil, "c/x/util.ts": nil, "src/there.ts": nil})
	cases := map[string]contract.Tool{
		"ambiguous":    failedRead(filepath.ToSlash(filepath.Join(f.root, "z", "x", "util.ts")), "File does not exist."),
		"did you mean": failedRead(filepath.ToSlash(filepath.Join(f.root, "src", "here", "there.ts")), "File does not exist. Did you mean src/there.ts?"),
		"exists":       failedRead(filepath.ToSlash(filepath.Join(f.root, "src", "there.ts")), "File does not exist."),
		"other error":  failedRead(filepath.ToSlash(filepath.Join(f.root, "src", "gone", "there.ts")), "Permission denied"),
		"outside":      failedRead("/elsewhere/there.ts", "File does not exist."),
	}
	interrupted := failedRead(filepath.ToSlash(filepath.Join(f.root, "src", "gone", "there.ts")), "File does not exist.")
	interrupted.Output.Interrupted = true
	cases["interrupted"] = interrupted
	for name, tool := range cases {
		ev := f.event(contract.PostToolFailure)
		ev.Tool = &tool
		if out := sendWith(t, ev, rescueEnv(f, "on")); out != "" {
			t.Fatal(name, out)
		}
	}
}

func TestSearchRescues(t *testing.T) {
	f := rescueFixture(t)
	plantIndex(t, f, map[string][]plantedSymbol{
		"src/users.ts":  {{"getUserById", "function", 12, 30}},
		"src/lookup.py": {{"user_lookup", "function", 3, 9}},
		"src/other.ts":  {{"render", "function", 1, 2}},
	})
	env := rescueEnv(f, "on")
	batch := func(tools ...contract.Tool) string {
		f.session += "x" // a fresh epoch each time, so dedupe doesn't hide a case
		return sendWith(t, f.event(contract.PostToolBatch, tools...), env)
	}
	if out := batch(grep("getUserById", "No matches found")); !strings.Contains(out, `No matches for "getUserById". Indexed definitions: src/users.ts:12 function getUserById`) {
		t.Fatal(out)
	}
	if out := batch(grep("user lookup", "No files found")); !strings.Contains(out, "src/lookup.py:3 function user_lookup") {
		t.Fatal("snake variant", out)
	}
	for _, silent := range []contract.Tool{grep("render", "No matches found"), grep("get.*User", "No matches found"), grep("nothingAnywhere", "No matches found")} {
		if out := batch(silent); out != "" {
			t.Fatal(silent.Input.Pattern, out)
		}
	}
	// Wide: a narrow result that misses the file defining the name.
	other := filepath.ToSlash(filepath.Join(f.root, "src", "other.ts"))
	if out := batch(grep("getUserById", "Found 1 file\n"+other)); !strings.Contains(out, "Not in these results, defined at: src/users.ts:12 function getUserById") {
		t.Fatal("wide", out)
	}
	users := filepath.ToSlash(filepath.Join(f.root, "src", "users.ts"))
	if out := batch(grep("getUserById", "Found 1 file\n"+users)); out != "" {
		t.Fatal("the search already found it", out)
	}
	got := strings.Join(surfaceRows(t, f), ",")
	if got != "rescue-search:given,rescue-search:given,rescue-wide:given" {
		t.Fatal(got)
	}
}

func TestGlobTimeoutRescue(t *testing.T) {
	f := rescueFixture(t)
	plantIndex(t, f, map[string][]plantedSymbol{"src/a.ts": nil, "src/b/c.ts": nil, "src/d.md": nil})
	glob := func(pattern string) contract.Event {
		ev := f.event(contract.PostToolFailure)
		ev.Tool = &contract.Tool{Name: contract.ToolGlob, RawName: "Glob", Input: contract.ToolInput{Pattern: pattern}, Output: &contract.ToolOutput{Text: "Glob timed out after 20 seconds", OK: false}}
		return ev
	}
	out := sendWith(t, glob("src/**/*.ts"), rescueEnv(f, "on"))
	if !strings.Contains(out, "Glob src/**/*.ts timed out. Matches from the file index:\nsrc/a.ts\nsrc/b/c.ts") || strings.Contains(out, "d.md") {
		t.Fatal(out)
	}
	for _, silent := range []string{"src/{a,b}/*.ts", "nothing/**/*.go"} {
		f.session += "x"
		if out := sendWith(t, glob(silent), rescueEnv(f, "on")); out != "" {
			t.Fatal(silent, out)
		}
	}
}

func TestCodexShellRescues(t *testing.T) {
	f := rescueFixture(t)
	f.agent = "codex"
	plantIndex(t, f, map[string][]plantedSymbol{"pkg/store/cache.go": {{"LoadCache", "function", 7, 20}}})
	one := 1
	cat := contract.Tool{Name: contract.ToolShell, RawName: "shell", Input: contract.ToolInput{Command: "cat pkg/cache.go"}, Output: &contract.ToolOutput{Text: "cat: pkg/cache.go: No such file or directory", OK: false, ExitCode: &one}}
	ev := f.event(contract.PostToolFailure)
	ev.Tool = &cat
	if out := sendWith(t, ev, rescueEnv(f, "on")); !strings.Contains(out, "No file at pkg/cache.go. Indexed files with that name: pkg/store/cache.go") {
		t.Fatal(out)
	}
	rg := contract.Tool{Name: contract.ToolShell, RawName: "shell", Input: contract.ToolInput{Command: "rg -n load_cache"}, Output: &contract.ToolOutput{Text: "", OK: false, ExitCode: &one}}
	ev.Tool = &rg
	if out := sendWith(t, ev, rescueEnv(f, "on")); !strings.Contains(out, "pkg/store/cache.go:7 function LoadCache") {
		t.Fatal(out)
	}
}

func TestRescueStartsInShadowAndSendsNothing(t *testing.T) {
	f := rescueFixture(t)
	plantIndex(t, f, map[string][]plantedSymbol{"src/new/client.ts": nil})
	ev := f.event(contract.PostToolFailure)
	tool := failedRead(filepath.ToSlash(filepath.Join(f.root, "src", "old", "client.ts")), "File does not exist.")
	ev.Tool = &tool
	if out := sendWith(t, ev, f.env()); out != "" {
		t.Fatal("a new surface sent before its trial", out)
	}
	if got := strings.Join(surfaceRows(t, f), ","); got != "rescue-wrong-path:shadow" {
		t.Fatal(got)
	}
	f.session = "off"
	if out := sendWith(t, ev, rescueEnv(f, "off")); out != "" || len(surfaceRows(t, f)) != 1 {
		t.Fatal("off still recorded or sent", out)
	}
}

func TestSearchTermsAndVariants(t *testing.T) {
	if got := strings.Join(searchTerms("getHTTPResponse user_id"), ","); got != "get,http,response,user,id" {
		t.Fatal(got)
	}
	if got := strings.Join(nameVariants("user id", []string{"user", "id"}), ","); got != "userId,UserId,user_id,USER_ID" {
		t.Fatal(got)
	}
	for p, heavy := range map[string]bool{"foo\\.bar": false, "foo\\s+bar": true, "a|b": true, "plain words": false} {
		if regexHeavy(p) != heavy {
			t.Fatal(p)
		}
	}
}
