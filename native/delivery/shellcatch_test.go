package delivery

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/check"
	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/internal/contract"
)

// countPatterns makes the planted index count literal patterns, with the
// given per-file counts at its last parse (zero counts left out, as the
// indexer writes them).
func countPatterns(t *testing.T, f *fixture, patterns []string, counts map[string]int) {
	t.Helper()
	db, err := sql.Open("sqlite", filepath.Join(index.Directory(f.dir, f.project), "c-test.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var ids []string
	for _, p := range patterns {
		ids = append(ids, check.PatternID(p))
	}
	list, _ := json.Marshal(ids)
	if _, err := db.Exec("INSERT INTO meta VALUES('pattern_ids', ?)", string(list)); err != nil {
		t.Fatal(err)
	}
	for file, n := range counts {
		if _, err := db.Exec("INSERT INTO counts VALUES(?,?,?,?)", "h-"+file, "ts", ids[0], n); err != nil {
			t.Fatal(err)
		}
	}
}

// A script rewrites a file: the hook only saw the command.
func scriptWrote(t *testing.T, f *fixture, rel, text string, at time.Time) {
	t.Helper()
	p := filepath.Join(filepath.FromSlash(f.root), filepath.FromSlash(rel))
	if err := os.WriteFile(p, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(p, at, at); err != nil {
		t.Fatal(err)
	}
}

func shellCatchFixture(t *testing.T) *fixture {
	f := rescueFixture(t)
	datesRule(f)
	plantIndex(t, f, map[string][]plantedSymbol{"apps/api/a.ts": nil, "apps/api/b.ts": nil, "apps/web/c.ts": nil})
	f.start("startup")
	return f
}

func TestShellEditCaughtAfterwards(t *testing.T) {
	f := shellCatchFixture(t)
	countPatterns(t, f, []string{"from 'moment'"}, nil)
	scriptWrote(t, f, "apps/api/a.ts", "import m from 'moment'\n", time.Now())
	out := f.send(f.event(contract.PostToolBatch, shell("node scripts/gen.js", "done", true)))
	if !strings.Contains(out, "date-fns") {
		t.Fatalf("not caught: %q", out)
	}
	// Once per epoch: delivery's ledger has it now.
	if out := f.send(f.event(contract.PostToolBatch, shell("node scripts/gen.js", "done", true))); strings.Contains(out, "date-fns") {
		t.Fatalf("caught twice: %q", out)
	}
}

func TestShellCatchStaysSilent(t *testing.T) {
	cases := map[string]struct {
		patterns []string
		before   map[string]int
		rel      string
		at       time.Duration
		command  string
	}{
		"already there at the last parse": {patterns: []string{"from 'moment'"}, before: map[string]int{"apps/api/a.ts": 1}, rel: "apps/api/a.ts", command: "node gen.js"},
		"the index doesn't count it":      {patterns: []string{"something else"}, rel: "apps/api/a.ts", command: "node gen.js"},
		"changed long ago":                {patterns: []string{"from 'moment'"}, rel: "apps/api/a.ts", at: -time.Hour, command: "node gen.js"},
		"out of the rule's scope":         {patterns: []string{"from 'moment'"}, rel: "apps/web/c.ts", command: "node gen.js"},
		"a read-only command":             {patterns: []string{"from 'moment'"}, rel: "apps/api/a.ts", command: "cat apps/api/a.ts"},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			f := shellCatchFixture(t)
			countPatterns(t, f, c.patterns, c.before)
			scriptWrote(t, f, c.rel, "import m from 'moment'\n", time.Now().Add(c.at))
			if out := f.send(f.event(contract.PostToolBatch, shell(c.command, "done", true))); strings.Contains(out, "date-fns") {
				t.Fatalf("caught: %q", out)
			}
		})
	}
}

func TestShellCatchWithoutAnIndexIsSilent(t *testing.T) {
	f := rescueFixture(t)
	datesRule(f)
	f.start("startup")
	f.file("apps/api/a.ts", "import m from 'moment'\n")
	if out := f.send(f.event(contract.PostToolBatch, shell("node gen.js", "done", true))); strings.Contains(out, "date-fns") {
		t.Fatalf("caught without an index: %q", out)
	}
}
