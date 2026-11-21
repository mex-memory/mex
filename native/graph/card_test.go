package graph

import (
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/internal/contract"
)

// fakeGraph answers like the graph store.
type fakeGraph struct {
	symbols      []Symbol
	callers      map[string][]Site
	tests        map[string][]TestLink
	unresolved   map[string]int
	unresolvedIn map[string]int
	callees      map[string][]Site
	built        map[string]string // path -> hash at build
	incomplete   bool
}

func (g *fakeGraph) AsOf() string { return "2026-11-17T10:00:00Z" }
func (g *fakeGraph) BuiltHash(path string) (string, bool) {
	h, ok := g.built[path]
	return h, ok
}
func (g *fakeGraph) BuiltFiles() map[string]string { return g.built }
func (g *fakeGraph) Resolve(query string) ([]Symbol, error) {
	q := ParseQuery(query)
	var out []Symbol
	for _, s := range g.symbols {
		if s.Name == q.Name && (q.File == "" || s.Path == q.File) {
			out = append(out, s)
		}
	}
	return out, nil
}
func (g *fakeGraph) Callers(id string) ([]Site, error)   { return g.callers[id], nil }
func (g *fakeGraph) Callees(id string) ([]Site, error)   { return g.callees[id], nil }
func (g *fakeGraph) Tests(id string) ([]TestLink, error) { return g.tests[id], nil }
func (g *fakeGraph) Unresolved(id string) int            { return g.unresolved[id] }
func (g *fakeGraph) UnresolvedIn(id string) int          { return g.unresolvedIn[id] }
func (g *fakeGraph) Complete() bool                      { return !g.incomplete }

// fakeFiles answers like the file index.
type fakeFiles struct {
	outlines map[string][]index.Symbol
	hashes   map[string]string
	tokens   map[string]int
	tests    map[string]bool
	edited   map[string]bool
	listing  bool
}

func (f *fakeFiles) Outline(path string) (*index.OutlineAnswer, *index.Miss) {
	s, ok := f.outlines[path]
	if !ok {
		return nil, &index.Miss{Path: path, NotIndexed: "not in the index"}
	}
	return &index.OutlineAnswer{Path: path, Symbols: s}, nil
}
func (f *fakeFiles) FileInfo(path string) (*index.FileInfoAnswer, *index.Miss) {
	h, ok := f.hashes[path]
	if !ok {
		return nil, &index.Miss{Path: path, NotIndexed: "not in the index"}
	}
	return &index.FileInfoAnswer{Path: path, Hash: h, Tokens: f.tokens[path], IsTest: f.tests[path]}, nil
}
func (f *fakeFiles) Edited(path string) bool { return f.edited[path] }
func (f *fakeFiles) TestFlag(path string) (bool, bool) {
	_, ok := f.hashes[path]
	return f.tests[path], ok
}

// listedFiles adds the listing "none" needs.
type listedFiles struct{ *fakeFiles }

func (l listedFiles) CodeFiles(bool) (map[string]string, error) {
	out := map[string]string{}
	for p, h := range l.hashes {
		if l.edited[p] {
			h = ""
		}
		out[p] = h
	}
	return out, nil
}

// texts is a Source over fixed file text.
func texts(files map[string]string) Source {
	return func(path string) []string {
		t, ok := files[path]
		if !ok {
			return nil
		}
		return strings.Split(t, "\n")
	}
}

// lines builds a file whose line n holds text[n], blank elsewhere.
func lines(n int, text map[int]string) string {
	out := make([]string, n)
	for i, t := range text {
		out[i-1] = t
	}
	return strings.Join(out, "\n")
}

func sym(id, name, path string, start, end int, kind string) Symbol {
	return Symbol{ID: id, Name: name, Path: path, Start: start, End: end, Kind: kind, Hash: "h-" + id}
}

// A router: parseRoute is called from two handlers, called by a test
// callback, passed as a value in another, and reached by an e2e test only
// through handleGet.
func router() (*fakeGraph, *fakeFiles, Source) {
	parse := sym("n1", "parseRoute", "src/router.ts", 120, 140, "function")
	parse.Exported, parse.Signature = true, "(path: string) => Route"
	get := sym("n2", "handleGet", "src/get.ts", 10, 30, "function")
	post := sym("n3", "handlePost", "src/post.ts", 5, 25, "function")
	it := sym("n4", "<callback:it[1]>", "test/router.test.ts", 3, 9, "function")
	cb := sym("n5", "<callback:it[2]>", "test/router.test.ts", 11, 14, "function")
	e2e := sym("n6", "<callback:it[1]>", "test/app.e2e.test.ts", 2, 8, "function")
	g := &fakeGraph{
		symbols: []Symbol{parse, get, post, it, cb, e2e},
		callers: map[string][]Site{
			"n1": {
				{Path: "src/get.ts", Line: 12, In: get, Kind: Call},
				{Path: "src/get.ts", Line: 20, In: get, Kind: Call},
				{Path: "src/post.ts", Line: 7, In: post, Kind: Call},
				{Path: "test/router.test.ts", Line: 5, In: it, Kind: Call},
				{Path: "test/router.test.ts", Line: 12, In: cb, Kind: Value},
			},
			"n2": {{Path: "test/app.e2e.test.ts", Line: 4, In: e2e, Kind: Call}},
		},
		tests: map[string][]TestLink{"n1": {{Test: it, Line: 5, Reach: Direct}, {Test: e2e, Line: 4, Reach: ViaCaller}}},
		built: map[string]string{"src/router.ts": "a", "src/get.ts": "b", "src/post.ts": "c", "test/router.test.ts": "d", "test/app.e2e.test.ts": "e"},
	}
	f := &fakeFiles{
		outlines: map[string][]index.Symbol{
			"src/router.ts": {{Name: "parseRoute", Kind: "function", Start: 120, End: 140}},
			"src/get.ts":    {{Name: "handleGet", Kind: "function", Start: 10, End: 30}},
			"src/post.ts":   {{Name: "handlePost", Kind: "function", Start: 5, End: 25}},
		},
		hashes: map[string]string{"src/router.ts": "a", "src/get.ts": "b", "src/post.ts": "c", "test/router.test.ts": "d", "test/app.e2e.test.ts": "e"},
		tokens: map[string]int{"src/router.ts": 2000, "src/get.ts": 800, "src/post.ts": 700, "test/router.test.ts": 500},
		tests:  map[string]bool{"test/router.test.ts": true, "test/app.e2e.test.ts": true},
	}
	src := texts(map[string]string{
		"src/router.ts":        lines(140, map[int]string{120: "export function parseRoute(path: string): Route {"}),
		"src/get.ts":           lines(30, map[int]string{12: "  const r = parseRoute(req.path)", 20: "  return parseRoute(alt)"}),
		"src/post.ts":          lines(25, map[int]string{7: "  const route = parseRoute(body.path)"}),
		"test/router.test.ts":  lines(14, map[int]string{3: "it('parses', () => {", 5: "  expect(parseRoute('/a')).toEqual(a)", 12: "  routes.map(parseRoute)"}),
		"test/app.e2e.test.ts": lines(8, map[int]string{4: "  await handleGet(req)"}),
	})
	return g, f, src
}

func TestSearchLines(t *testing.T) {
	g, f, src := router()
	v := View{R: g, Files: f, Src: src}
	text, value, ok := v.SearchLines("src/router.ts", "parseRoute", 600, nil)
	if !ok {
		t.Fatal("no lines")
	}
	want := "called by 2:\n" +
		"  src/get.ts:12 handleGet · const r = parseRoute(req.path)\n" +
		"  src/post.ts:7 handlePost · const route = parseRoute(body.path)\n" +
		"test: test/router.test.ts:5 · expect(parseRoute('/a')).toEqual(a)"
	if text != want {
		t.Fatalf("text:\n%s", text)
	}
	// The value passed in a test callback is never a caller; the test's call
	// is said once, as the test.
	if strings.Contains(text, "routes.map") || strings.Count(text, "router.test.ts") != 1 {
		t.Fatalf("callback or test shown as a caller:\n%s", text)
	}
	if value != 800+700+500 {
		t.Fatalf("value %d", value)
	}
	// Lines the search already returned aren't repeated.
	shown := func(code string) bool { return strings.Contains(code, "req.path") }
	text, _, _ = v.SearchLines("src/router.ts", "parseRoute", 600, shown)
	if strings.Contains(text, "req.path") || !strings.Contains(text, "src/get.ts:12 handleGet\n") {
		t.Fatalf("repeated a shown line:\n%s", text)
	}
}

func TestSearchLinesNoise(t *testing.T) {
	g, f, src := router()
	g.symbols = append(g.symbols, sym("n9", "parseRoute", "src/legacy.ts", 1, 5, "function"))
	if _, _, ok := (View{g, f, src}).SearchLines("src/router.ts", "parseRoute", 600, nil); ok {
		t.Fatal("a name with two definitions got lines")
	}
	g, f, src = router()
	f.outlines["src/router.ts"][0].End = 120 + maxSpanLines
	if _, _, ok := (View{g, f, src}).SearchLines("src/router.ts", "parseRoute", 600, nil); ok {
		t.Fatal("a span over 300 lines got lines")
	}
	g, f, src = router()
	if _, _, ok := (View{g, f, src}).SearchLines("src/other.ts", "parseRoute", 600, nil); ok {
		t.Fatal("lines for a definition the span isn't showing")
	}
	g, f, src = router()
	g.unresolved = map[string]int{"n1": 2}
	if text, _, _ := (View{g, f, src}).SearchLines("src/router.ts", "parseRoute", 600, nil); !strings.HasSuffix(text, "+2 dynamic uses not resolved") {
		t.Fatalf("unresolved:\n%s", text)
	}
}

// With no caller and no test there is nothing to say; with only a test
// reached through a caller, that test is said. Absence is never claimed.
func TestSearchLinesSayOnlyWhatIsKnown(t *testing.T) {
	g, f, src := router()
	g.callers["n1"] = nil
	g.tests = nil
	if _, _, ok := (View{g, f, src}).SearchLines("src/router.ts", "parseRoute", 600, nil); ok {
		t.Fatal("lines with nothing in them")
	}
	g.tests = map[string][]TestLink{"n1": {{Test: g.symbols[5], Line: 4, Reach: ViaCaller}}}
	text, _, ok := (View{g, f, src}).SearchLines("src/router.ts", "parseRoute", 600, nil)
	if !ok || text != "tested only through a caller: test/app.e2e.test.ts:4" {
		t.Fatalf("via caller:\n%s", text)
	}
}

func TestSearchLinesFitTheRoom(t *testing.T) {
	g, f, src := router()
	// Short of room, callers lose their code lines before any caller goes.
	text, _, ok := (View{g, f, src}).SearchLines("src/router.ts", "parseRoute", 140, nil)
	if !ok || len(text) > 140 || !strings.Contains(text, "src/get.ts:12 handleGet\n  src/post.ts:7 handlePost\n") || strings.Contains(text, "req.path") {
		t.Fatalf("fitted:\n%s", text)
	}
	text, _, ok = (View{g, f, src}).SearchLines("src/router.ts", "parseRoute", 110, nil)
	if !ok || text != "called by 2:\n  src/get.ts:12 handleGet\n  src/post.ts:7 handlePost\ntest: test/router.test.ts:5" {
		t.Fatalf("fitted smaller:\n%s", text)
	}
	text, _, ok = (View{g, f, src}).SearchLines("src/router.ts", "parseRoute", 80, nil)
	if !ok || len(text) > 80 || !strings.Contains(text, "+1 more") {
		t.Fatalf("fitted smallest:\n%s", text)
	}
	if _, _, ok := (View{g, f, src}).SearchLines("src/router.ts", "parseRoute", 20, nil); ok {
		t.Fatal("lines in a room too small for them")
	}
}

// A use in a file changed since the build is found again in today's text:
// kept with today's line when the call is still in its function, dropped
// when the call or the function is gone.
func TestRecheckChangedFiles(t *testing.T) {
	g, f, _ := router()
	f.hashes["src/get.ts"] = "edited"
	f.outlines["src/get.ts"] = []index.Symbol{{Name: "handleGet", Kind: "function", Start: 14, End: 34}}
	moved := texts(map[string]string{"src/get.ts": lines(34, map[int]string{16: "  const r = parseRoute(req.path)", 24: "  return other(alt)"})})
	kept, dropped := Recheck(g.callers["n1"][:2], "parseRoute", g, f, moved)
	if dropped != 1 || len(kept) != 1 || kept[0].Line != 16 || kept[0].In.Start != 14 {
		t.Fatalf("moved: %+v dropped %d", kept, dropped)
	}
	f.outlines["src/get.ts"] = []index.Symbol{{Name: "handleGetV2", Kind: "function", Start: 10, End: 30}}
	if kept, dropped := Recheck(g.callers["n1"][:2], "parseRoute", g, f, moved); len(kept) != 0 || dropped != 2 {
		t.Fatalf("function gone: %+v", kept)
	}
	// A file the hook edited still has its parsed hash: it is not as built.
	g, f, _ = router()
	f.edited = map[string]bool{"src/post.ts": true}
	gone := texts(map[string]string{"src/post.ts": lines(25, map[int]string{7: "  const route = other(body.path)"})})
	if kept, dropped := Recheck(g.callers["n1"][2:3], "parseRoute", g, f, gone); len(kept) != 0 || dropped != 1 {
		t.Fatal("an edited file's removed call was kept")
	}
	// No text to read: dropped, never kept as built.
	if kept, _ := Recheck(g.callers["n1"][2:3], "parseRoute", g, f, nil); len(kept) != 0 {
		t.Fatal("kept without reading the file")
	}
}

func TestUsesWord(t *testing.T) {
	for line, want := range map[string]bool{
		"parseRoute(x)":         true,
		"a.parseRoute":          true,
		"parseRoutes(x)":        false,
		"reparseRoute(x)":       false,
		"$parseRoute":           false,
		"x = parseRoute":        true,
		"// parseRoute is used": true,
	} {
		if got := usesWord(line, "parseRoute"); got != want {
			t.Errorf("%q: got %v", line, got)
		}
	}
}

// "None" only when every file is indexed, nothing was dropped, and no file
// changed since the build uses the name; otherwise "unknown".
func TestAskNeverOverclaims(t *testing.T) {
	g, f, src := router()
	g.callers["n1"] = nil
	files := listedFiles{f}
	if a, _ := Ask(g, files, src, OpCallers, "parseRoute"); a.Verdict != None || a.Changed != 0 {
		t.Fatalf("complete: %+v", a)
	}
	g.incomplete = true
	if a, _ := Ask(g, files, src, OpCallers, "parseRoute"); a.Verdict != Unknown {
		t.Fatalf("incomplete: %+v", a)
	}
	g.incomplete = false
	// A file added after the build uses the name: the graph can't show it.
	f.hashes["src/new.ts"] = "z"
	src2 := func(p string) []string {
		if p == "src/new.ts" {
			return []string{"parseRoute('/x')"}
		}
		return src(p)
	}
	if a, _ := Ask(g, files, src2, OpCallers, "parseRoute"); a.Verdict != Unknown || a.Changed != 1 {
		t.Fatalf("new file: %+v", a)
	}
	delete(f.hashes, "src/new.ts")
	// A file of a kind the graph never builds can't hold a use it missed.
	f.hashes["tools/gen.py"] = "p"
	src3 := func(p string) []string {
		if p == "tools/gen.py" {
			return []string{"parseRoute('/x')"}
		}
		return src(p)
	}
	if a, _ := Ask(g, files, src3, OpCallers, "parseRoute"); a.Verdict != None || a.Changed != 0 {
		t.Fatalf("other kind: %+v", a)
	}
	delete(f.hashes, "tools/gen.py")
	// Without a listing of the files, absence can't be told.
	if a, _ := Ask(g, f, src, OpCallers, "parseRoute"); a.Verdict != Unknown || a.Changed != -1 {
		t.Fatalf("no listing: %+v", a)
	}
	// Tests: the direct one is found.
	g, f, src = router()
	a, _ := Ask(g, listedFiles{f}, src, OpTests, "parseRoute")
	if a.Verdict != Found || len(a.Tests) != 2 || a.Tests[0].Reach != Direct {
		t.Fatalf("tests: %+v", a)
	}
}

func TestAskCallees(t *testing.T) {
	g, f, src := router()
	files := listedFiles{f}
	if a, _ := Ask(g, files, src, OpCallees, "handleGet"); a.Verdict != None {
		t.Fatalf("no calls: %+v", a)
	}
	g.unresolvedIn = map[string]int{"n2": 3}
	if a, _ := Ask(g, files, src, OpCallees, "handleGet"); a.Verdict != Unknown || a.Unresolved != 3 {
		t.Fatalf("unresolved calls: %+v", a)
	}
	g.unresolvedIn = nil
	g.callees = map[string][]Site{"n2": {{Path: "src/get.ts", Line: 12, In: g.symbols[0], Kind: Call}}}
	if a, _ := Ask(g, files, src, OpCallees, "handleGet"); a.Verdict != Found || len(a.Sites) != 1 {
		t.Fatalf("calls: %+v", a)
	}
	f.hashes["src/get.ts"] = "edited"
	if a, _ := Ask(g, files, src, OpCallees, "handleGet"); a.Verdict != Unknown || a.Dropped != 1 {
		t.Fatalf("changed body: %+v", a)
	}
}

func TestAskImpactFollowsNamedCode(t *testing.T) {
	g, f, src := router()
	a, _ := Ask(g, listedFiles{f}, src, OpImpact, "parseRoute")
	var got []string
	for _, s := range a.Sites {
		got = append(got, s.Named().Name)
	}
	// handleGet, handlePost, the test callback, then the e2e test through handleGet.
	if strings.Join(got, ",") != "handleGet,handlePost,<callback:it[1]>,<callback:it[1]>" {
		t.Fatalf("impact: %v", got)
	}
}

func TestParseQuery(t *testing.T) {
	for in, want := range map[string]Query{
		"getPath":                  {Name: "getPath"},
		"Router.add":               {Owner: "Router", Name: "add"},
		"a.b.c":                    {Owner: "a::b", Name: "c"},
		"Router::add":              {Owner: "Router", Name: "add"},
		"src/utils/url.ts:getPath": {File: "src/utils/url.ts", Name: "getPath"},
		"./url.ts:Router.add":      {File: "url.ts", Owner: "Router", Name: "add"},
		"handler.ts:A::B::c":       {File: "handler.ts", Owner: "A::B", Name: "c"},
		"  spaced  ":               {Name: "spaced"},
	} {
		if got := ParseQuery(in); got != want {
			t.Errorf("%q: got %+v want %+v", in, got, want)
		}
	}
}

func TestSignatureCard(t *testing.T) {
	g, f, src := router()
	def := g.symbols[0]
	v := View{g, f, src}
	if _, ok := v.SignatureCard(def, "export function parseRoute(path: string, base?: string): Route {", 4, Seen{}); ok {
		t.Fatal("card below the fan-out")
	}
	c, ok := v.SignatureCard(def, "export function parseRoute(path: string, base?: string): Route {", 2, Seen{})
	if !ok || !strings.Contains(c.Text, "used by 3 files: src/get.ts:12, src/post.ts:7, test/router.test.ts:5") {
		t.Fatalf("card: %+v", c)
	}
	if _, ok := v.SignatureCard(def, "x", 2, Seen{c.Key: true}); !ok {
		t.Fatal("a different declaration is a new card")
	}
	if _, ok := v.SignatureCard(def, "export function parseRoute(path: string, base?: string): Route {", 2, Seen{c.Key: true}); ok {
		t.Fatal("repeated in the epoch")
	}
	def.Exported = false
	if _, ok := v.SignatureCard(def, "y", 2, Seen{}); ok {
		t.Fatal("card for an unexported definition")
	}
}

func TestTestsCard(t *testing.T) {
	g, f, src := router()
	v := View{g, f, src}
	c, ok := v.TestsCard([]Symbol{g.symbols[0]}, "npx vitest run", 3000, Seen{})
	if !ok {
		t.Fatal("no card")
	}
	want := "Tests covering your changes: test/router.test.ts (direct); test/app.e2e.test.ts (through a tested caller)\n" +
		"To rerun only those: `npx vitest run test/router.test.ts test/app.e2e.test.ts`"
	if c.Text != want || c.Value != 3000 {
		t.Fatalf("card:\n%s", c.Text)
	}
	g.tests["n2"] = []TestLink{{Test: g.symbols[5], Line: 4, Reach: Direct}}
	if _, ok := v.TestsCard([]Symbol{g.symbols[1]}, "npm test", 3000, Seen{}); !ok {
		t.Fatal("handleGet is reached by the e2e test")
	}
	g.tests = nil
	if _, ok := v.TestsCard([]Symbol{g.symbols[0]}, "npx vitest run", 3000, Seen{}); ok {
		t.Fatal("card with no tests")
	}
}

func TestScopedCommand(t *testing.T) {
	for _, c := range []struct {
		command string
		want    string
	}{
		{"npx vitest run", "npx vitest run a.test.ts"},
		{"npx jest", "npx jest a.test.ts"},
		{"pytest -q", "pytest -q a.test.ts"},
		{"npm test", ""},
		{"npx vitest run src/b.test.ts", ""},
		{"npx vitest run | tail", ""},
	} {
		got, ok := ScopedCommand(c.command, []string{"a.test.ts"})
		if (c.want == "") == ok || got != c.want {
			t.Errorf("%q: got %q %v", c.command, got, ok)
		}
	}
}

func TestNothingAtSessionStart(t *testing.T) {
	if Allowed(contract.SessionStart) || !Allowed(contract.PostTool) {
		t.Fatal("session start must send no card")
	}
}
