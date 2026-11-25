package delivery

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record"
)

// generatedPitfall is knowledge-08's pitfall for files with a generated header.
func generatedPitfall(f *fixture) {
	f.entry(spec{id: "mx_factgen", kind: "pitfall", scope: "src/gen/**", evidence: "mined", source: "mined", ref: "src/gen/**",
		oneLine: "Files under `src/gen/` are generated; don't edit them by hand.",
		checks:  []string{"    - kind: pattern\n      role: supporting\n      target: {scope: \"src/gen/**\", pattern: \"DO NOT EDIT\", match: literal}\n      saw: {count: 2}\n      files: {}\n"}})
	f.verdict("mx_factgen", held)
}

// The ticket's demo: a generated file edited by hand is sent back once, with
// the reason.
func TestStopSendsBackOnceForAHandEditedGeneratedFile(t *testing.T) {
	f := newFixture(t)
	generatedPitfall(f)
	f.start("startup")
	f.file("src/gen/api.ts", "// DO NOT EDIT\nexport const x = 2\n")
	f.journal(editRow("src/gen/api.ts"))

	r := stopNow(f)
	if r.Decision != contract.Deny {
		t.Fatalf("hand edit not sent back: %+v", r)
	}
	for _, want := range []string{"You edited `src/gen/api.ts` by hand.", "Files under `src/gen/` are generated", "regenerate", "(mx_factgen)"} {
		if !strings.Contains(r.Reason, want) {
			t.Fatalf("reason lacks %q:\n%s", want, r.Reason)
		}
	}
	f.journal(editRow("src/gen/api.ts"))
	if r := stopNow(f); r.Decision != "" {
		t.Fatalf("sent back twice: %+v", r)
	}
}

func TestStopGeneratedFileFixedByALaterCommand(t *testing.T) {
	t.Run("regenerated", func(t *testing.T) {
		f := newFixture(t)
		generatedPitfall(f)
		f.start("startup")
		p := f.file("src/gen/api.ts", "// DO NOT EDIT\nexport const x = 2\n")
		f.journal(editRow("src/gen/api.ts"))
		f.journal(commandRow("npm run generate", 0))
		later := time.Now().Add(time.Minute)
		if err := os.Chtimes(filepath.FromSlash(p), later, later); err != nil {
			t.Fatal(err)
		}
		if r := stopNow(f); r.Decision != "" {
			t.Fatalf("regenerated file sent back: %+v", r)
		}
	})
	t.Run("reverted by deleting", func(t *testing.T) {
		f := newFixture(t)
		generatedPitfall(f)
		f.start("startup")
		p := f.file("src/gen/api.ts", "x\n")
		f.journal(editRow("src/gen/api.ts"))
		f.journal(commandRow("git rm -f src/gen/api.ts", 0))
		if err := os.Remove(filepath.FromSlash(p)); err != nil {
			t.Fatal(err)
		}
		if r := stopNow(f); r.Decision != "" {
			t.Fatalf("removed file sent back: %+v", r)
		}
	})
	t.Run("a command that left the file alone", func(t *testing.T) {
		f := newFixture(t)
		generatedPitfall(f)
		f.start("startup")
		p := f.file("src/gen/api.ts", "x\n")
		past := time.Now().Add(-time.Hour)
		if err := os.Chtimes(filepath.FromSlash(p), past, past); err != nil {
			t.Fatal(err)
		}
		f.journal(editRow("src/gen/api.ts"))
		f.journal(commandRow("git status", 0))
		if r := stopNow(f); r.Decision != contract.Deny {
			t.Fatalf("untouched hand edit not sent back: %+v", r)
		}
	})
	t.Run("outside the generated scope", func(t *testing.T) {
		f := newFixture(t)
		generatedPitfall(f)
		f.start("startup")
		f.file("src/app.ts", "x\n")
		f.journal(editRow("src/app.ts"))
		if r := stopNow(f); r.Decision != "" {
			t.Fatalf("ordinary file sent back: %+v", r)
		}
	})
}

// recipesFacts writes setup's recipes.json for the fixture's project.
func recipesFacts(f *fixture, body string) {
	f.t.Helper()
	dir := filepath.Join(f.home, "projects", f.project)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "recipes.json"), []byte(body), 0o600); err != nil {
		f.t.Fatal(err)
	}
}

const pnpmRepo = `{"version":1,"manager":"pnpm","packages":[{"path":"","name":"root","kind":"node"},{"path":"packages/api","name":"api","kind":"node"}],"recipes":[],"review":[]}`

func TestStopSendsBackForTheWrongLockfile(t *testing.T) {
	f := newFixture(t)
	recipesFacts(f, pnpmRepo)
	f.file("pnpm-lock.yaml", "lockfileVersion: 9\n")
	f.start("startup")
	f.journal(commandRow("cd packages/api && npm install", 0))
	f.file("packages/api/package-lock.json", "{}\n")

	r := stopNow(f)
	if r.Decision != contract.Deny {
		t.Fatalf("wrong lockfile not sent back: %+v", r)
	}
	for _, want := range []string{"`packages/api/package-lock.json`", "a lockfile from npm", "this repo uses pnpm", "`pnpm install`"} {
		if !strings.Contains(r.Reason, want) {
			t.Fatalf("reason lacks %q:\n%s", want, r.Reason)
		}
	}
	f.journal(commandRow("npm install", 0))
	if r := stopNow(f); r.Decision != "" {
		t.Fatalf("sent back twice: %+v", r)
	}
}

func TestStopLockfileSilentCases(t *testing.T) {
	cases := map[string]struct {
		recipes string
		setup   func(*fixture)
		rows    []record.JournalRow
	}{
		"the repo's own lockfile": {recipes: pnpmRepo, setup: func(f *fixture) { f.file("pnpm-lock.yaml", "x\n") }, rows: []record.JournalRow{commandRow("pnpm install", 0)}},
		"older than the turn": {recipes: pnpmRepo, setup: func(f *fixture) {
			p := f.file("package-lock.json", "{}\n")
			past := time.Now().Add(-time.Hour)
			_ = os.Chtimes(filepath.FromSlash(p), past, past)
		}, rows: []record.JournalRow{commandRow("ls", 0)}},
		"no command this turn":  {recipes: pnpmRepo, setup: func(f *fixture) { f.file("package-lock.json", "{}\n") }, rows: []record.JournalRow{editRow("a.ts")}},
		"no manager found":      {recipes: `{"version":1,"manager":null,"packages":[],"review":[]}`, setup: func(f *fixture) { f.file("package-lock.json", "{}\n") }, rows: []record.JournalRow{commandRow("npm install", 0)}},
		"repo keeps two":        {recipes: `{"version":1,"manager":"pnpm","packages":[],"review":[{"kind":"two-lockfiles"}]}`, setup: func(f *fixture) { f.file("package-lock.json", "{}\n") }, rows: []record.JournalRow{commandRow("npm install", 0)}},
		"no setup facts":        {setup: func(f *fixture) { f.file("package-lock.json", "{}\n") }, rows: []record.JournalRow{commandRow("npm install", 0)}},
		"unknown facts version": {recipes: `{"version":2,"manager":"pnpm"}`, setup: func(f *fixture) { f.file("package-lock.json", "{}\n") }, rows: []record.JournalRow{commandRow("npm install", 0)}},
		"not a package folder":  {recipes: pnpmRepo, setup: func(f *fixture) { f.file("tools/package-lock.json", "{}\n") }, rows: []record.JournalRow{commandRow("cd tools && npm install", 0)}},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			f := newFixture(t)
			if c.recipes != "" {
				recipesFacts(f, c.recipes)
			}
			f.start("startup")
			f.journal(c.rows...)
			c.setup(f)
			if r := stopNow(f); r.Decision != "" {
				t.Fatalf("sent back: %+v", r)
			}
		})
	}
}
