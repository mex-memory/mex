package delivery

import (
	"path"
	"sort"
	"strings"

	"github.com/mex-memory/mex/native/graph"
	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/index/shift"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/internal/shellparse"
	"github.com/mex-memory/mex/native/internal/tokens"
	"github.com/mex-memory/mex/native/record/place"
)

// The card after a full test run: once the session has edited code, the
// tests that cover the definitions it changed, and a scoped command when the
// runner takes files, so the runs that follow are scoped. It goes out after
// the run, not before it: context a host adds before a tool lands after the
// tool's result (measured on Claude Code), so it could never replace that
// run. Its value is what the run's output cost; it goes out only when that
// is at least twice the card. The output is a floor on what a rerun costs:
// agents often trim it (| tail), and the run's time isn't counted at all.

const (
	maxChangedSymbols = 32
	// testRunValueFactor: the run's output must cost this many times the card.
	testRunValueFactor = 2
)

// fullTestRun reports a shell command that ran a whole test suite: a test
// command that names no test files, directories or name filters.
func fullTestRun(ev contract.Event) bool {
	if (ev.Kind != contract.PostTool && ev.Kind != contract.PostToolFailure) || ev.Tool == nil || ev.Tool.Name != contract.ToolShell || ev.Tool.Output == nil {
		return false
	}
	return fullTestCommand(ev.Tool.Input.Command)
}

// fullTestCommand reports a command that runs a whole test suite.
func fullTestCommand(command string) bool {
	if !testCommand(command) {
		return false
	}
	for _, segment := range shellparse.Segments(command) {
		if !testCommand(segment) {
			continue
		}
		words := shellparse.Words(segment)
		for i := 1; i < len(words); i++ {
			w := words[i]
			switch {
			case w == "-t" || w == "-k" || w == "-run" || w == "--grep" || w == "-g" ||
				strings.HasPrefix(w, "--testNamePattern") || strings.HasPrefix(w, "-testNamePattern") ||
				strings.HasPrefix(w, "--run=") || strings.HasPrefix(w, "-run="):
				return false // a name filter
			case w == "--config" || w == "-c" || w == "--project" || w == "--root" || w == "--dir" || w == "--reporter" || w == "-p" ||
				w == "--filter" || w == "-F" || w == "--workspace" || w == "-w":
				i++ // the flag's value (a package for --filter or -w) is not a target
			case strings.HasPrefix(w, "--filter=") || strings.HasPrefix(w, "--workspace="):
			case i == 2 && words[1] == "workspace":
				// yarn workspace <package> test: the package, not a target
			case strings.HasPrefix(w, "-"):
			case w == "." || w == "./..." || w == "...":
			case strings.Contains(w, "/") || path.Ext(w) != "":
				return false // names files or directories
			}
		}
	}
	return true
}

// testRunCards finds the tests covering what this session changed in the
// event's checkout. Silent without the file index, the graph, or a changed
// definition the graph knows.
func testRunCards(ev contract.Event, env Environment) []answerCard {
	if ev.ProjectID == "" || ev.Checkout == "" || surfaceSetting(env, ev.ProjectID, graphCardSurface) == "off" {
		return nil
	}
	changed := map[string][]LineSpan{}
	for file, spans := range env.Changed {
		if rel, ok := place.RelativeToCheckout(ev.Checkout, file); ok {
			changed[rel] = append(changed[rel], spans...)
		}
	}
	if len(changed) == 0 {
		return nil
	}
	view, ix, done := graphViewIndex(ev, env)
	if done == nil {
		return nil
	}
	defer done()
	symbols := changedDefinitions(view, ix, changed)
	if len(symbols) == 0 {
		return nil
	}
	value := tokens.Code(boundedText(ev.Tool.Output.Text, 1<<20))
	card, ok := view.TestsCard(symbols, ev.Tool.Input.Command, value, graph.Seen{})
	if !ok || card.Value < testRunValueFactor*card.Tokens {
		return nil
	}
	return []answerCard{graphAnswerCard(card)}
}

// graphDefinition is the graph's node for a definition the file index holds:
// same file, name and kind, the nearest one when the name repeats.
func graphDefinition(store *graph.Store, rel, name, kind string, start int) (graph.Symbol, bool) {
	defs, err := store.Resolve(name)
	if err != nil {
		return graph.Symbol{}, false
	}
	var best graph.Symbol
	found := false
	for _, d := range defs {
		if d.Path != rel || d.Kind != kind {
			continue
		}
		if !found || abs(d.Start-start) < abs(best.Start-start) {
			best, found = d, true
		}
	}
	return best, found
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// changedDefinitions lists the innermost definitions the changed lines
// touch, outside test files, at most maxChangedSymbols of them, each with
// the file's hash today.
func changedDefinitions(view graph.View, ix *index.Reader, changed map[string][]LineSpan) []graph.Symbol {
	isTest := func(path string) bool {
		if t, known := ix.TestFlag(path); known {
			return t
		}
		return graph.TestPath(path)
	}
	store := view.R.(*graph.Store)

	rels := make([]string, 0, len(changed))
	for rel := range changed {
		rels = append(rels, rel)
	}
	sort.Strings(rels)
	var symbols []graph.Symbol
	for _, rel := range rels {
		if isTest(rel) {
			continue // editing a test is not a change the tests cover
		}
		// The file's hash today: the card comes back only after a new edit.
		// A file changed outside the hook has no index answer until it
		// re-parses; its text stands in.
		lines := view.Src(rel)
		var hash string
		var outlined []shift.Symbol
		if info, miss := ix.FileInfo(rel); miss == nil {
			hash = info.Hash
		} else if lines != nil {
			hash = contentHash(strings.Join(lines, "\n"))
		} else {
			continue
		}
		if outline, miss := ix.Outline(rel); miss == nil {
			outlined = outline.Symbols
		}
		spans := mergeSpans(changed[rel])
		// The innermost definitions a change touches: a class whose method
		// changed is not itself changed.
		touched := map[int]bool{}
		for i, sym := range outlined {
			if overlaps(spans, sym.Start, sym.End) {
				touched[i] = true
			}
		}
		for i := range touched {
			if p := outlined[i].Parent; p != nil {
				delete(touched, *p)
			}
		}
		// An edited definition's lines are let go by the file index until it
		// re-parses: the graph's definitions, found in today's text, fill in
		// the ones the outline no longer has.
		inOutline := map[string]bool{}
		for _, sym := range outlined {
			inOutline[sym.Name] = true
		}
		var fromGraph []graph.Symbol
		if lines != nil {
			if defs, err := store.Declared(rel); err == nil {
				for _, d := range defs {
					if inOutline[d.Name] || d.Kind == "class" || d.Kind == "interface" {
						continue
					}
					if now, ok := graph.DeclaredIn(lines, d); ok && overlaps(spans, now.Start, now.End) {
						d.Hash = hash
						fromGraph = append(fromGraph, d)
					}
				}
			}
		}
		indices := make([]int, 0, len(touched))
		for i := range touched {
			indices = append(indices, i)
		}
		sort.Ints(indices)
		for _, d := range fromGraph {
			if len(symbols) < maxChangedSymbols {
				symbols = append(symbols, d)
			}
		}
		for _, i := range indices {
			sym := outlined[i]
			def, ok := graphDefinition(store, rel, sym.Name, sym.Kind, sym.Start)
			if !ok {
				continue
			}
			def.Hash = hash
			symbols = append(symbols, def)
			if len(symbols) >= maxChangedSymbols {
				break
			}
		}
		if len(symbols) >= maxChangedSymbols {
			break
		}
	}
	return symbols
}
