package delivery

import (
	"path"
	"sort"
	"strings"

	"github.com/mex-memory/mex/native/graph"
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
// is several times the card.

const (
	maxChangedSymbols = 32
	// testRunValueFactor: the run's output must cost this many times the card.
	testRunValueFactor = 4
)

// fullTestRun reports a shell command that ran a whole test suite: a test
// command that names no test files, directories or name filters.
func fullTestRun(ev contract.Event) bool {
	if (ev.Kind != contract.PostTool && ev.Kind != contract.PostToolFailure) || ev.Tool == nil || ev.Tool.Name != contract.ToolShell || ev.Tool.Output == nil {
		return false
	}
	command := ev.Tool.Input.Command
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
			case w == "--config" || w == "-c" || w == "--project" || w == "--root" || w == "--dir" || w == "--reporter" || w == "-p":
				i++ // the flag's value is not a target
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
		info, miss := ix.FileInfo(rel)
		outline, omiss := ix.Outline(rel)
		if miss != nil || omiss != nil {
			continue
		}
		spans := mergeSpans(changed[rel])
		// The innermost definitions a change touches: a class whose method
		// changed is not itself changed.
		touched := map[int]bool{}
		for i, sym := range outline.Symbols {
			if overlaps(spans, sym.Start, sym.End) {
				touched[i] = true
			}
		}
		for i := range touched {
			if p := outline.Symbols[i].Parent; p != nil {
				delete(touched, *p)
			}
		}
		indices := make([]int, 0, len(touched))
		for i := range touched {
			indices = append(indices, i)
		}
		sort.Ints(indices)
		for _, i := range indices {
			sym := outline.Symbols[i]
			def, ok := graphDefinition(store, rel, sym.Name, sym.Kind, sym.Start)
			if !ok {
				continue
			}
			// The file's hash today: the card comes back only after a new edit.
			def.Hash = info.Hash
			symbols = append(symbols, def)
			if len(symbols) >= maxChangedSymbols {
				break
			}
		}
		if len(symbols) >= maxChangedSymbols {
			break
		}
	}
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
