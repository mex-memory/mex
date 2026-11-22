package delivery

import (
	"encoding/json"
	"fmt"
	"math"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/mex-memory/mex/native/graph"
	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
)

// Graph cards: the graph's answer at the moment it replaces work the agent
// is about to do.
//   - Beside a noisy search for a name: the callers in code, each with the
//     definition it's in and its line, and the test that calls it. With the
//     span card when there is one (spans.go), else on its own.
//   - After an edit that changes a definition's declaration, when 5 or more
//     other files use it: the files to fix.
//   - After a full test run once the session has edited code: the tests that
//     cover the change, for the runs that follow (testrun.go).
// They go through the same budget as knowledge, in the cards lane, and carry
// the tokens of the reads they replace as their value. Each is silent on any
// doubt: a name the graph doesn't hold once, a missing graph or file index,
// a span too long to help, an answer with nothing new in it.

const graphCardSurface = "graph-card"

// impactFiles: the impact note after a signature change goes out only when
// this many other files use the symbol. Below it the agent's own follow-up
// is cheap; the note pays only on high fan-out.
const impactFiles = 5

var (
	// declaration finds a named definition's first line, in the languages
	// the graph extracts: function/def/func/fn forms, functions bound to a
	// const, and method shorthand. A call statement never matches: a method
	// form must open its body on the same line.
	declaration = sync.OnceValue(func() *regexp.Regexp {
		mods := `^[ \t]*(?:export[ \t]+)?(?:default[ \t]+)?(?:declare[ \t]+)?(?:pub(?:\([^)\n]*\))?[ \t]+)?(?:(?:public|private|protected|static|async|override|readonly|abstract)[ \t]+)*`
		generic := `(?:<[^>\n]*>)?`
		return regexp.MustCompile(`(?m)` + mods + `(?:` +
			`(?:function\*?|def|fn|func(?:[ \t]*\([^)\n]*\))?)[ \t]+([A-Za-z_$][\w$]*)[ \t]*` + generic + `[ \t]*\([^\n]*` +
			`|(?:const|let|var)[ \t]+([A-Za-z_$][\w$]*)[ \t]*(?::[^=\n]+)?=[ \t]*(?:async[ \t]+)?(?:function\b[^(\n]*)?` + generic + `[ \t]*\([^\n]*` +
			`|(?:get[ \t]+|set[ \t]+)?([A-Za-z_$#][\w$]*)[ \t]*` + generic + `[ \t]*\([^)\n]*\)[^\n;]*\{[ \t]*$` +
			`)`)
	})
)

// noisyFiles: a search with hits in this many files is one grep didn't
// settle; symbol help pays only on such names.
const noisyFiles = 3

// graphView opens what a graph card reads: the file index, the graph, and
// files as they are now. close is nil when nothing could be opened.
func graphView(ev contract.Event, env Environment) (graph.View, func()) {
	view, _, done := graphViewIndex(ev, env)
	return view, done
}

func graphViewIndex(ev contract.Event, env Environment) (graph.View, *index.Reader, func()) {
	ix := openRescueIndex(env, ev)
	if ix == nil {
		// Without the file index nothing can be re-checked: say nothing.
		return graph.View{}, nil, nil
	}
	isTest := func(path string) bool {
		if t, known := ix.TestFlag(path); known {
			return t
		}
		return graph.TestPath(path)
	}
	store, err := graph.OpenStore(env.RecordDirectory, ev.ProjectID, ev.Checkout, isTest)
	if err != nil {
		closeRescueIndex(env, ix)
		return graph.View{}, nil, nil
	}
	return graph.View{R: store, Files: graph.Cached(ix), Src: graph.DiskSource(ev.Checkout)}, ix, func() {
		store.Close()
		closeRescueIndex(env, ix)
	}
}

// graphCards finds the impact note an edit calls for. It does string work
// first; the graph is opened only when an edit changed a declaration.
func graphCards(ev contract.Event, env Environment) []answerCard {
	if ev.ProjectID == "" || ev.Checkout == "" || !graph.Allowed(ev.Kind) {
		return nil
	}
	if len(env.Changed) >= maxChangedFiles {
		return nil // at capacity the session store may have dropped a caller
	}
	if ev.Kind != contract.PostTool && ev.Kind != contract.PostToolBatch && len(env.shellChanges) == 0 {
		return nil
	}
	if surfaceSetting(env, ev.ProjectID, graphCardSurface) == "off" {
		return nil
	}
	type change struct {
		rel, name, declaration string
		def                    *graph.Symbol // already placed in today's text
	}
	type edit struct{ rel, added string }
	var changes []change
	var inner []edit
	excluded := map[string]bool{}
	for _, v := range views(ev, env.Resolve) {
		if v.failed || v.output == nil || !v.output.OK || v.output.Interrupted || v.rel == "" || v.checkout != ev.Checkout {
			continue
		}
		var removed, added string
		switch v.name {
		case contract.ToolEdit, contract.ToolPatch:
			removed, added = v.removed, v.added
		case contract.ToolWrite:
			removed, added = patchText(v.output.Text)
		default:
			continue
		}
		excluded[v.rel] = true
		found := changedDeclarations(removed, added)
		for name, line := range found {
			changes = append(changes, change{rel: v.rel, name: name, declaration: line})
			if len(changes) >= 8 {
				break
			}
		}
		if len(found) == 0 && strings.TrimSpace(added) != "" && normalizeDeclaration(removed) != normalizeDeclaration(added) && len(inner) < 4 {
			inner = append(inner, edit{v.rel, added})
		}
	}
	if len(changes) == 0 && len(inner) == 0 && len(env.shellChanges) == 0 {
		return nil
	}
	view, done := graphView(ev, env)
	if done == nil {
		return nil
	}
	defer done()
	// An edit inside a multi-line signature (its parameters) names no
	// declaration itself: find the definition whose header it falls in.
	addHeaders := func(hits []headerHit) {
		for _, h := range hits {
			def := h.def
			changes = append(changes, change{rel: def.Path, name: def.Name, declaration: h.header, def: &def})
		}
	}
	for _, e := range inner {
		addHeaders(headerChanges(view, e.rel, e.added))
	}
	paths := make([]string, 0, len(env.shellChanges))
	for rel := range env.shellChanges {
		excluded[rel] = true
		paths = append(paths, rel)
	}
	sort.Strings(paths)
	for _, rel := range paths {
		spans := env.shellChanges[rel]
		if len(spans) == 1 && spans[0].To == math.MaxInt32 {
			continue // no old header to compare
		}
		addHeaders(signatureHeaders(view, rel, view.Src(rel), func(start, end int) bool {
			return overlaps(spans, start, end)
		}))
	}
	if len(changes) > 0 {
		for file := range env.Changed {
			if rel, ok := place.RelativeToCheckout(ev.Checkout, file); ok {
				excluded[rel] = true
			}
		}
	}
	var out []answerCard
	seen := graph.Seen{}
	for _, c := range changes {
		// The definition in the edited file, by that file: a changed call
		// elsewhere never reads as a changed declaration.
		var def graph.Symbol
		if c.def != nil {
			def = *c.def
		} else {
			defs, err := view.R.Resolve(c.rel + ":" + c.name)
			if err != nil || len(defs) != 1 {
				continue
			}
			// The file was just edited, so the file index has let go of the
			// definition's lines: today's text at its built start must still
			// open with the new declaration.
			def = defs[0]
			if exact, ok := graph.Exact(view.Files, def); ok {
				def = exact
			}
			if !strings.Contains(normalizeDeclaration(view.Code(def.Path, def.Start)), firstWords(c.declaration)) {
				continue
			}
		}
		if card, ok := view.SignatureCard(def, c.declaration, impactFiles, seen, excluded); ok {
			seen[card.Key] = true
			cardOut := graphAnswerCard(card)
			cardOut.symPath, cardOut.symName = def.Path, def.Name
			out = append(out, cardOut)
		}
	}
	return out
}

// headerHit is a definition whose signature an edit falls inside.
type headerHit struct {
	def    graph.Symbol
	header string
}

// headerChanges finds the definitions in rel whose signature, from its
// first line to where its parameters close, holds the edit's added text as
// the file reads today. Each comes with its header as one line. The
// definitions come from the graph (the file index lets go of an edited
// definition's lines until it re-parses), each checked against today's text:
// its first line must still name it.
func headerChanges(view graph.View, rel, added string) []headerHit {
	if view.Src == nil {
		return nil
	}
	lines := view.Src(rel)
	if lines == nil {
		return nil
	}
	// The edit's lines, found as one block in today's text.
	var want []string
	for _, l := range strings.Split(strings.ReplaceAll(added, "\r\n", "\n"), "\n") {
		if t := strings.TrimSpace(l); t != "" {
			want = append(want, t)
		}
	}
	if len(want) == 0 || len(strings.Join(want, "")) < 3 {
		return nil
	}
	at := 0
	for i := range lines {
		if strings.TrimSpace(lines[i]) == "" {
			continue // else a block after a blank line matches twice
		}
		j, k := i, 0
		for ; j < len(lines) && k < len(want); j++ {
			t := strings.TrimSpace(lines[j])
			if t == "" {
				continue
			}
			if t != want[k] {
				break
			}
			k++
		}
		if k == len(want) {
			if at != 0 {
				return nil // the edit's text is in more than one place
			}
			at = i + 1
		}
	}
	if at == 0 {
		return nil
	}
	return signatureHeaders(view, rel, lines, func(start, end int) bool { return start <= at && at <= end })
}

func signatureHeaders(view graph.View, rel string, lines []string, touches func(start, end int) bool) []headerHit {
	if len(lines) == 0 {
		return nil
	}
	var defs []graph.Symbol
	if d, ok := view.R.(graph.Declarer); ok {
		var err error
		if defs, err = d.Declared(rel); err != nil {
			return nil
		}
	} else if view.Files != nil {
		if outline, miss := view.Files.Outline(rel); miss == nil && outline != nil {
			for _, sym := range outline.Symbols {
				defs = append(defs, graph.Symbol{Name: sym.Name, Path: rel, Start: sym.Start, End: sym.End, Kind: sym.Kind})
			}
		}
	}
	var out []headerHit
	for _, def := range defs {
		def, ok := graph.DeclaredIn(lines, def)
		if !ok {
			continue
		}
		end, header := signatureEnd(lines, def.Start)
		if touches(def.Start, end) {
			out = append(out, headerHit{def, header})
		}
	}
	return out
}

const maxHeaderLines = 40

// signatureEnd is the line where a definition's parameter list closes (its
// body or arrow follows), and the header joined as one line.
func signatureEnd(lines []string, start int) (int, string) {
	depth, opened := 0, false
	var parts []string
	for i := start - 1; i < len(lines) && i < start-1+maxHeaderLines; i++ {
		l := lines[i]
		parts = append(parts, strings.TrimSpace(l))
		for _, r := range l {
			switch r {
			case '(':
				depth++
				opened = true
			case ')':
				depth--
			}
		}
		if opened && depth <= 0 {
			return i + 1, strings.Join(strings.Fields(strings.Join(parts, " ")), " ")
		}
	}
	return start, strings.TrimSpace(lines[start-1])
}

// firstWords is the start of a declaration line, enough to know it's the
// line the file index places the definition at.
func firstWords(line string) string {
	n := normalizeDeclaration(line)
	if r := []rune(n); len(r) > 40 {
		return string(r[:40])
	}
	return n
}

// patchText is the removed and added lines of a Write's structured patch,
// as Claude Code reports it; both empty for a new file or no patch.
func patchText(response string) (removed, added string) {
	if len(response) > 1<<20 || !strings.Contains(response, "structuredPatch") {
		return "", ""
	}
	var parsed struct {
		Patch []struct {
			Lines []string `json:"lines"`
		} `json:"structuredPatch"`
	}
	if json.Unmarshal([]byte(response), &parsed) != nil {
		return "", ""
	}
	var r, a strings.Builder
	for _, hunk := range parsed.Patch {
		for _, line := range hunk.Lines {
			switch {
			case strings.HasPrefix(line, "-"):
				r.WriteString(line[1:] + "\n")
			case strings.HasPrefix(line, "+"):
				a.WriteString(line[1:] + "\n")
			}
		}
	}
	return r.String(), a.String()
}

func graphAnswerCard(card *graph.Card) answerCard {
	return answerCard{
		surface: graphCardSurface,
		text:    card.Text,
		id:      "mex:graph:" + card.Key,
		value:   card.Value,
		detail:  card.Kind,
		target:  record.SurfaceTarget{},
	}
}

// changedDeclarations are the definitions an edit keeps by name but
// declares differently: name to the new declaration line.
func changedDeclarations(old, new string) map[string]string {
	before := declarations(old)
	out := map[string]string{}
	for name, line := range declarations(new) {
		if prior, ok := before[name]; ok && normalizeDeclaration(prior) != normalizeDeclaration(line) {
			out[name] = strings.TrimSpace(line)
		}
	}
	return out
}

func declarations(text string) map[string]string {
	if len(text) > 64*1024 {
		text = text[:64*1024]
	}
	out := map[string]string{}
	for _, m := range declaration().FindAllStringSubmatch(text, 32) {
		name := m[1] + m[2] + m[3]
		switch name {
		case "", "if", "for", "while", "switch", "catch", "return", "function", "new", "await", "else", "do", "try", "with":
			continue
		}
		if _, dup := out[name]; dup {
			// Overloads: leave the name alone rather than guess.
			out[name] = ""
			continue
		}
		out[name] = m[0]
	}
	for name, line := range out {
		if line == "" {
			delete(out, name)
		}
	}
	return out
}

func normalizeDeclaration(line string) string { return strings.Join(strings.Fields(line), " ") }

func valueDetail(kind string, value int) string {
	return kind + " value=" + strconv.Itoa(value)
}

// searchShows is what a search's output already shows, so a card line the
// agent has isn't repeated.
func searchShows(output string) graph.Shown {
	if len(output) > 1<<20 {
		return func(string) bool { return true }
	}
	var lines []string
	for _, line := range strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n") {
		if t := strings.TrimSpace(resultLabelRE().ReplaceAllString(line, "")); t != "" {
			lines = append(lines, t)
		}
	}
	joined := "\n" + strings.Join(lines, "\n") + "\n"
	return func(code string) bool {
		code = strings.TrimSuffix(code, "…")
		return len(code) >= 8 && strings.Contains(joined, code)
	}
}

// graphSearchLines are the graph's lines for a card about span's definition,
// in the room head leaves.
func graphSearchLines(ev contract.Event, env Environment, view graph.View, span SpanAnswer, head, output string) (string, int, bool) {
	room := spanCharacters - utf8.RuneCountInString(head) - 1
	if room <= 0 {
		return "", 0, false
	}
	return view.SearchLines(span.Path, span.name, room, searchShows(output))
}

// graphSearchCard is the card beside a noisy search for a name when no span
// card went out (the search already showed the definition, or it was too
// long): where the name is defined, then the graph's lines.
func graphSearchCard(ev contract.Event, env Environment, view graph.View, tool contract.Tool) (answerCard, bool) {
	name, scope, ok := spanPattern(ev, tool)
	if !ok || name == "" || !noisySearch(ev, tool) {
		return answerCard{}, false
	}
	def, ok := view.Unique(name)
	if !ok || !withinScope(ev.Checkout, scope, def.Path) {
		return answerCard{}, false
	}
	head := fmt.Sprintf("%s:%d %s", def.Path, def.Start, def.Name)
	if code := view.Code(def.Path, def.Start); code != "" && !searchShows(tool.Output.Text)(code) {
		head = fmt.Sprintf("%s:%d %s", def.Path, def.Start, code)
	}
	if utf8.RuneCountInString(head) > 240 {
		head = fmt.Sprintf("%s:%d %s", def.Path, def.Start, def.Name)
	}
	span := SpanAnswer{Path: def.Path, Start: def.Start, End: def.Start, name: def.Name}
	lines, value, ok := graphSearchLines(ev, env, view, span, head, tool.Output.Text)
	if !ok {
		return answerCard{}, false
	}
	text := head + "\n" + lines
	return answerCard{surface: graphCardSurface, text: text, id: "mex:graph:" + contentHash(text)[7:31], value: value, detail: "search",
		target: record.SurfaceTarget{Paths: []string{def.Path}, Start: def.Start, End: def.Start}, symPath: def.Path, symName: def.Name}, true
}

// noisySearch is a search with hits in several files, or many lines: one
// whose answer grep alone didn't settle.
func noisySearch(ev contract.Event, tool contract.Tool) bool {
	if tool.Output == nil {
		return false
	}
	if _, _, _, files, lines, ok := searchResult(ev, tool); ok {
		return len(files) >= noisyFiles || lines >= rescueWideMax
	}
	// Other agents' shell searches: count the files the output names.
	files, lines := map[string]bool{}, 0
	for _, line := range strings.Split(boundedText(tool.Output.Text, 1<<18), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || line == "--" {
			continue
		}
		lines++
		from := 0
		if len(line) > 2 && line[1] == ':' {
			from = 2
		}
		if i := strings.IndexByte(line[from:], ':'); i > 0 {
			files[filepath.ToSlash(line[:from+i])] = true
		}
	}
	return len(files) >= noisyFiles || lines >= rescueWideMax
}
