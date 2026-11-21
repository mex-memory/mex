package delivery

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/mex-memory/mex/native/graph"
	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record"
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
	if ev.Kind != contract.PostTool && ev.Kind != contract.PostToolBatch {
		return nil
	}
	if surfaceSetting(env, ev.ProjectID, graphCardSurface) == "off" {
		return nil
	}
	type change struct{ rel, name, declaration string }
	var changes []change
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
		for name, line := range changedDeclarations(removed, added) {
			changes = append(changes, change{v.rel, name, line})
			if len(changes) >= 8 {
				break
			}
		}
	}
	if len(changes) == 0 {
		return nil
	}
	view, done := graphView(ev, env)
	if done == nil {
		return nil
	}
	defer done()
	var out []answerCard
	seen := graph.Seen{}
	for _, c := range changes {
		// The definition in the edited file, by that file: a changed call
		// elsewhere never reads as a changed declaration.
		defs, err := view.R.Resolve(c.rel + ":" + c.name)
		if err != nil || len(defs) != 1 {
			continue
		}
		def, ok := graph.Exact(view.Files, defs[0])
		if !ok || !strings.Contains(normalizeDeclaration(view.Code(def.Path, def.Start)), firstWords(c.declaration)) {
			continue
		}
		if card, ok := view.SignatureCard(def, c.declaration, impactFiles, seen); ok {
			seen[card.Key] = true
			cardOut := graphAnswerCard(card)
			cardOut.symPath, cardOut.symName = def.Path, def.Name
			out = append(out, cardOut)
		}
	}
	return out
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
