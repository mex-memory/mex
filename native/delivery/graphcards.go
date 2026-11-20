package delivery

import (
	"regexp"
	"strconv"
	"strings"
	"sync"

	"github.com/mex-memory/mex/native/graph"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record"
)

// Graph cards: the graph's answer at the moment it replaces work the agent
// is about to do. They go through the same budget as knowledge, in the cards
// lane, and carry the tokens of the reads they replace as their value. Each
// is silent on any doubt: a name the graph doesn't hold once, a missing
// graph, a span too long to help.

const graphCardSurface = "graph-card"

var (
	identifier = sync.OnceValue(func() *regexp.Regexp { return regexp.MustCompile(`^[A-Za-z_$][A-Za-z0-9_$]{2,80}$`) })
	// declaration finds a named definition at the start of a line, in the
	// languages the graph extracts: function/def/func/fn forms and methods.
	declaration = sync.OnceValue(func() *regexp.Regexp {
		return regexp.MustCompile(`(?m)^\s*(?:export\s+)?(?:default\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*` +
			`(?:function\*?\s+|def\s+|func\s+(?:\([^)]*\)\s*)?|fn\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>\n]*>)?\s*\(([^)\n]*)\)[^\n{]*`)
	})
)

// graphCards finds the graph cards one event calls for. It does string work
// first; the graph is opened only when a moment matched.
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
	tools := ev.Batch
	if ev.Tool != nil {
		tools = []contract.Tool{*ev.Tool}
	}
	if len(tools) > 16 {
		tools = tools[:16]
	}
	var searches []string
	type changed struct{ name, signature string }
	var edits []changed
	for _, tool := range tools {
		if tool.Output == nil || !tool.Output.OK || tool.Output.Interrupted {
			continue
		}
		switch {
		case searchEvent(ev):
			if pattern, _, _, _, _, ok := searchResult(ev, tool); ok && identifier().MatchString(pattern) {
				searches = append(searches, pattern)
			}
		case tool.Name == contract.ToolEdit && tool.Input.Old != nil && tool.Input.New != nil:
			for name, signature := range changedSignatures(*tool.Input.Old, *tool.Input.New) {
				edits = append(edits, changed{name, signature})
			}
		}
	}
	if len(searches) == 0 && len(edits) == 0 {
		return nil
	}
	ix := openRescueIndex(env, ev)
	if ix == nil {
		// Without the file index nothing can be re-checked: say nothing.
		return nil
	}
	defer closeRescueIndex(env, ix)
	isTest := func(path string) bool {
		info, miss := ix.FileInfo(path)
		return miss == nil && info.IsTest
	}
	store, err := graph.OpenStore(env.RecordDirectory, ev.ProjectID, ev.Checkout, isTest)
	if err != nil {
		return nil
	}
	defer store.Close()

	var out []answerCard
	seen := graph.Seen{}
	for _, name := range searches {
		if card, ok := graph.SearchCard(store, ix, name, seen); ok {
			seen[card.Key] = true
			out = append(out, graphAnswerCard(card))
		}
	}
	for _, e := range edits {
		defs, err := store.Resolve(e.name)
		if err != nil || len(defs) != 1 {
			continue
		}
		before := defs[0].Signature
		def, ok := graph.Exact(ix, defs[0])
		if !ok {
			continue
		}
		def.Signature = e.signature
		if card, ok := graph.SignatureCard(store, ix, def, before, seen); ok {
			seen[card.Key] = true
			out = append(out, graphAnswerCard(card))
		}
	}
	return out
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

// changedSignatures are the definitions an edit keeps by name but declares
// differently: name to the new declaration line.
func changedSignatures(old, new string) map[string]string {
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
	out := map[string]string{}
	for _, m := range declaration().FindAllStringSubmatch(text, 16) {
		name := m[1]
		switch name {
		case "if", "for", "while", "switch", "catch", "return", "function", "new", "await":
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
