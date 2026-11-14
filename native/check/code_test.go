package check

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/index"
)

// fakeIndex answers like the file index for a few files.
type fakeIndex struct {
	outlines map[string][]index.Symbol
	dropped  map[string]int
	counts   map[string]int // pattern id -> count, for any scope
}

func (f *fakeIndex) Outline(path string) (*index.OutlineAnswer, *index.Miss) {
	symbols, ok := f.outlines[path]
	if !ok {
		return nil, &index.Miss{Path: path, NotIndexed: "not in the index"}
	}
	return &index.OutlineAnswer{Path: path, Symbols: symbols, Dropped: f.dropped[path]}, nil
}

func (f *fakeIndex) FileInfo(path string) (*index.FileInfoAnswer, *index.Miss) {
	return nil, &index.Miss{Path: path, NotIndexed: "not in the index"}
}

func (f *fakeIndex) SymbolsNamed(name string) ([]index.SymbolHit, error) {
	var hits []index.SymbolHit
	for path, symbols := range f.outlines {
		for _, s := range symbols {
			if s.Name == name {
				hits = append(hits, index.SymbolHit{Path: path, Start: s.Start, End: s.End, Kind: s.Kind})
			}
		}
	}
	return hits, nil
}

func (f *fakeIndex) PatternCounts(scope string, ids []string) (map[string]int, error) {
	out := map[string]int{}
	for _, id := range ids {
		if n, ok := f.counts[id]; ok {
			out[id] = n
		}
	}
	return out, nil
}

func indexed(t *testing.T, root string, ix *fakeIndex) *Evaluator {
	ev := evaluator(t, root)
	ev.UseIndex(ix)
	return ev
}

const cors = `import type { CORSOptions } from './types'

const defaults: CORSOptions = {
  origin: '*',
  allowMethods: ['GET', 'HEAD', 'PUT', 'POST', 'DELETE', 'PATCH'],
  allowHeaders: [],
  maxAge: 600,
  credentials: false,
}

export const cors = (options?: CORSOptions) => { return { ...defaults, ...options } }
`

// The demo: change the list and the note breaks; reformat and it holds.
func TestValueCheckCors(t *testing.T) {
	root := t.TempDir()
	write(t, root, "src/middleware/cors/index.ts", cors)
	c := record(t, root, "value", Complete, map[string]any{"file": "src/middleware/cors/index.ts", "symbol": "defaults.allowMethods"})
	if !equalValues(c.Saw["value"], []any{"GET", "HEAD", "PUT", "POST", "DELETE", "PATCH"}) {
		t.Fatalf("saw %#v", c.Saw["value"])
	}
	reformatted := strings.NewReplacer(
		"allowMethods: ['GET', 'HEAD', 'PUT', 'POST', 'DELETE', 'PATCH'],",
		"// methods every browser sends\n  allowMethods: [\n    \"GET\",\n    \"HEAD\",\n    \"PUT\",\n    \"POST\",\n    \"DELETE\",\n    \"PATCH\",\n  ],",
	).Replace(cors)
	write(t, root, "src/middleware/cors/index.ts", reformatted)
	if r := verdict(t, root, c); r.Verdict != Held {
		t.Fatalf("reformatted: %+v", r)
	}
	write(t, root, "src/middleware/cors/index.ts", strings.Replace(cors, "'DELETE', 'PATCH'", "'DELETE', 'PATCH', 'OPTIONS'", 1))
	if r := verdict(t, root, c); r.Verdict != Broken || r.Checks[0].Status != Fail {
		t.Fatalf("changed: %+v", r)
	}
	write(t, root, "src/middleware/cors/index.ts", strings.Replace(cors, "allowMethods: [", "allowMethods: METHODS || [", 1))
	if r := verdict(t, root, c); r.Checks[0].Status != Floor || r.Verdict != Changed {
		t.Fatalf("no longer literal: %+v", r)
	}
	write(t, root, "src/middleware/cors/index.ts", strings.Replace(cors, "const defaults", "const corsDefaults", 1))
	if r := verdict(t, root, c); r.Verdict != Broken || r.Checks[0].Status != Gone {
		t.Fatalf("renamed: %+v", r)
	}
}

func TestValueShapes(t *testing.T) {
	cases := []struct {
		file, src, symbol string
		want              any
	}{
		{"a.ts", "export const LIMITS = Object.freeze({ max: 5, names: ['a', \"b\"] } as const);", "LIMITS.names", []any{"a", "b"}},
		{"a.ts", "export let retries: number = 3;", "retries", 3},
		{"a.js", "let x = { 'quoted-key': { deep: -1.5e2, ok: true, none: null } }", "x.quoted-key", map[string]any{"deep": -150.0, "ok": true, "none": nil}},
		{"a.py", "TIMEOUT: int = 30\nALLOWED = (\"GET\", 'HEAD',)  # read only\n", "ALLOWED", []any{"GET", "HEAD"}},
		{"a.py", "CONFIG = {\"retries\": 3, \"backoff\": [1, 2, 4]}\n", "CONFIG.backoff", []any{1, 2, 4}},
		{"a.rs", "const MAX_SIZE: usize = 4_194_304;", "MAX_SIZE", 4194304},
		{"cfg.json", `{"server": {"port": 8080}}`, "server.port", 8080},
	}
	for _, c := range cases {
		root := t.TempDir()
		write(t, root, c.file, c.src)
		got := record(t, root, "value", Complete, map[string]any{"file": c.file, "symbol": c.symbol})
		if !equalValues(got.Saw["value"], c.want) {
			t.Errorf("%s %s: %#v", c.file, c.symbol, got.Saw["value"])
		}
	}
	for _, src := range []string{"const x = compute()", "const x = `a${b}`", "const x = 'a' + b", "const x = [a, b]"} {
		root := t.TempDir()
		write(t, root, "a.ts", src)
		if _, err := evaluator(t, root).Record("value", Complete, map[string]any{"file": "a.ts", "symbol": "x"}); !errors.Is(err, ErrNotRecordable) {
			t.Errorf("%s recorded: %v", src, err)
		}
	}
}

const router = `export class Router {
  routes = []

  // the most specific route wins
  match(method, path) {
    const found = this.routes.filter(r => r.method === method && r.test(path))
    return found.sort((a, b) => b.score - a.score)[0];
  }
}
`

func routerIndex(file string, start, end int) *fakeIndex {
	zero := 0
	return &fakeIndex{outlines: map[string][]index.Symbol{file: {
		{Name: "Router", Kind: "class", Start: 1, End: end + 1},
		{Name: "match", Kind: "method", Start: start, End: end, Parent: &zero},
	}}}
}

func TestSymbolCheck(t *testing.T) {
	root := t.TempDir()
	write(t, root, "src/router.ts", router)
	ix := routerIndex("src/router.ts", 5, 8)
	c, err := indexed(t, root, ix).Record("symbol", Supporting, map[string]any{"file": "src/router.ts", "symbol": "Router.match"})
	if err != nil {
		t.Fatal(err)
	}
	check := func(want string, status Status) {
		t.Helper()
		r := indexed(t, root, ix).Evaluate(&Entry{ID: "mx_router", Status: "active", Checks: []Check{c}})
		if r.Verdict != want || r.Checks[0].Status != status {
			t.Fatalf("want %s/%s, got %+v", want, status, r)
		}
	}

	// Comments, quotes, semicolons, trailing commas and layout: same tree.
	formatted := strings.NewReplacer(
		"  // the most specific route wins\n", "",
		"const found = this.routes.filter(r => r.method === method && r.test(path))", "const found = this.routes.filter(\n      r => r.method === method && r.test(path),\n    );",
		"[0];", "[0]",
	).Replace(router)
	write(t, root, "src/router.ts", formatted)
	ix.outlines["src/router.ts"] = routerIndex("src/router.ts", 4, 9).outlines["src/router.ts"]
	check(Held, Pass)

	// A real change.
	write(t, root, "src/router.ts", strings.Replace(router, "b.score - a.score", "a.score - b.score", 1))
	ix.outlines["src/router.ts"] = routerIndex("src/router.ts", 5, 8).outlines["src/router.ts"]
	check(Changed, Fail)

	// Moved to another file: found again by fingerprint.
	write(t, root, "src/router.ts", "export class Router {}\n")
	write(t, root, "src/match.ts", "export class Matcher {\n"+strings.Join(strings.Split(router, "\n")[4:8], "\n")+"\n}\n")
	zero := 0
	ix.outlines = map[string][]index.Symbol{
		"src/router.ts": {{Name: "Router", Kind: "class", Start: 1, End: 1}},
		"src/match.ts":  {{Name: "Matcher", Kind: "class", Start: 1, End: 6}, {Name: "match", Kind: "method", Start: 2, End: 5, Parent: &zero}},
	}
	check(Held, Pass)

	// Renamed in place.
	write(t, root, "src/router.ts", strings.Replace(router, "match(method", "find(method", 1))
	ix.outlines = routerIndex("src/router.ts", 5, 8).outlines
	ix.outlines["src/router.ts"][1].Name = "find"
	check(Held, Pass)

	// Gone.
	write(t, root, "src/router.ts", "export class Router {}\n")
	ix.outlines = map[string][]index.Symbol{"src/router.ts": {{Name: "Router", Kind: "class", Start: 1, End: 1}}}
	check(Changed, Gone)

	// An edit the index can't place yet: the file hashes decide.
	ix.dropped = map[string]int{"src/router.ts": 1}
	check(Changed, Floor)

	// No index at all: file hashes.
	r := evaluator(t, root).Evaluate(&Entry{ID: "mx_router", Status: "active", Checks: []Check{c}})
	if r.Checks[0].Status != Floor || r.Verdict != Changed {
		t.Fatalf("no index: %+v", r)
	}
}

func TestStaleIndexSpanIsNotTrusted(t *testing.T) {
	root := t.TempDir()
	write(t, root, "src/router.ts", "\n\n"+router)
	ix := routerIndex("src/router.ts", 5, 8) // spans from before two lines were added
	if _, err := indexed(t, root, ix).Record("symbol", Complete, map[string]any{"file": "src/router.ts", "symbol": "Router.match"}); !errors.Is(err, ErrNotRecordable) {
		t.Fatalf("recorded through a stale span: %v", err)
	}
}

func TestPatternCheck(t *testing.T) {
	root := t.TempDir()
	id := PatternID("from 'moment'")
	ix := &fakeIndex{counts: map[string]int{id: 0}}
	target := map[string]any{"scope": "apps/api/**", "pattern": "from 'moment'", "match": "literal"}
	c, err := indexed(t, root, ix).Record("pattern", Supporting, target)
	if err != nil || len(c.Files) != 0 {
		t.Fatalf("record: %v %+v", err, c)
	}
	c.Saw["count"] = 0 // as read back from an entry file
	run := func() Result {
		return indexed(t, root, ix).Evaluate(&Entry{ID: "mx_moment", Status: "active", Checks: []Check{c}})
	}
	if r := run(); r.Verdict != Held {
		t.Fatalf("held: %+v", r)
	}
	ix.counts[id] = 2
	if r := run(); r.Verdict != Changed || r.Checks[0].Now != 2 {
		t.Fatalf("rose: %+v", r)
	}
	delete(ix.counts, id)
	if r := run(); r.Checks[0].Status != Floor {
		t.Fatalf("not counted: %+v", r)
	}
	if _, err := indexed(t, root, ix).Record("pattern", Supporting, target); !errors.Is(err, ErrNotRecordable) {
		t.Fatalf("recorded an uncounted pattern: %v", err)
	}
	if PatternID("x") != "p"+strings.TrimPrefix(hashBytes([]byte("literal\nx")), "sha256:")[:15] {
		t.Fatal("pattern id differs from the file index's")
	}
}

// The plan's bench: 219 checks for 132 entries in 0.3 s. Here the same
// number of config, doc and code checks must finish well under a second.
func TestManyEntriesAreFast(t *testing.T) {
	root := t.TempDir()
	write(t, root, "package.json", pkg)
	write(t, root, "CONTRIBUTING.md", contributing)
	var b strings.Builder
	for i := 0; i < 40; i++ {
		fmt.Fprintf(&b, "export const setting%d = { list: ['a', 'b', %d], on: true }\n", i, i)
	}
	write(t, root, "src/settings.ts", b.String())
	ev := evaluator(t, root)
	var entries []*Entry
	for i := 0; i < 132; i++ {
		var checks []Check
		for _, spec := range []struct {
			kind   string
			target map[string]any
		}{
			{"key", map[string]any{"file": "package.json", "pointer": "/scripts/test"}},
			{"section", map[string]any{"file": "CONTRIBUTING.md", "heading": "Dev container"}},
			{"value", map[string]any{"file": "src/settings.ts", "symbol": fmt.Sprintf("setting%d.list", i%40)}},
		}[:min(3, 1+i%3+i%2)] {
			c, err := ev.Record(spec.kind, Complete, spec.target)
			if err != nil {
				t.Fatal(err)
			}
			checks = append(checks, c)
		}
		entries = append(entries, &Entry{ID: fmt.Sprintf("mx_%06d", i), Status: "active", Checks: checks})
	}
	started := time.Now()
	fresh := evaluator(t, root)
	total := 0
	for _, e := range entries {
		total += len(e.Checks)
		if r := fresh.Evaluate(e); r.Verdict != Held {
			t.Fatalf("%s: %+v", e.ID, r)
		}
	}
	elapsed := time.Since(started)
	t.Logf("%d checks for %d entries in %s", total, len(entries), elapsed)
	if elapsed > 500*time.Millisecond {
		t.Fatalf("too slow: %s", elapsed)
	}
}
