package delivery

import (
	"fmt"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/mex-memory/mex/native/graph"
	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/internal/shellparse"
	"github.com/mex-memory/mex/native/record"
)

const spanCharacters = 600

var bareNameRE = lazy(`^[A-Za-z_][A-Za-z0-9_]*$`)
var definitionRE = lazy(`^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:func|function|class|def|type|interface|struct|enum|const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:[({:=<]|$)`)
var assignmentRE = lazy(`^([A-Za-z_][A-Za-z0-9_]*)\s*=$`)

// DefinitionName accepts a single literal symbol intent, never a broad regex.
func DefinitionName(pattern string) string {
	if len(pattern) > 256 {
		return ""
	}
	p := strings.TrimSpace(pattern)
	p = strings.TrimPrefix(p, "^")
	p = strings.TrimSuffix(p, "$")
	p = strings.TrimPrefix(p, `\b`)
	p = strings.TrimSuffix(p, `\b`)
	if bareNameRE().MatchString(p) {
		return p
	}
	if m := definitionRE().FindStringSubmatch(p); m != nil {
		return m[1]
	}
	if m := assignmentRE().FindStringSubmatch(p); m != nil {
		return m[1]
	}
	return ""
}

func searchEvent(ev contract.Event) bool {
	if ev.Kind != contract.PostTool && ev.Kind != contract.PostToolBatch {
		// Codex maps grep's normal no-match status to PostToolFailure.
		if ev.Kind != contract.PostToolFailure || ev.Tool == nil || !codexSearchNoMatch(ev.Agent, *ev.Tool) {
			return false
		}
	}
	tools := ev.Batch
	if ev.Tool != nil {
		tools = append([]contract.Tool{*ev.Tool}, tools...)
	}
	for _, tool := range tools {
		if tool.Name == contract.ToolSearch || tool.Name == contract.ToolShell && shellparse.SearchSegment(boundedText(tool.Input.Command, 8192)) != "" {
			return true
		}
	}
	return false
}

func spanPattern(ev contract.Event, tool contract.Tool) (string, string, bool) {
	if tool.Output == nil || (!tool.Output.OK && !codexSearchNoMatch(ev.Agent, tool)) {
		return "", "", false
	}
	pattern, scope := tool.Input.Pattern, tool.Input.Path
	switch tool.Name {
	case contract.ToolSearch:
		// A type/glob filter can exclude the indexed answer: abstain conservatively.
		if tool.Input.Filter != "" {
			return "", "", false
		}
	case contract.ToolShell:
		if len(tool.Input.Command) > 8192 || shellparse.SearchSegment(tool.Input.Command) == "" {
			return "", "", false
		}
		if tool.Output.ExitCode != nil && *tool.Output.ExitCode != 0 && *tool.Output.ExitCode != 1 {
			return "", "", false
		}
		if ev.Agent == "codex" && tool.Output.ExitCode == nil && !codexSearchHasResults(tool.Input.Command, tool.Output) {
			return "", "", false
		}
		pattern = shellparse.SearchPattern(tool.Input.Command)
		cwd := shellparse.SearchCwd(tool.Input.Command, ev.Cwd)
		var filtered bool
		scope, filtered = shellSearchScope(tool.Input.Command, pattern, cwd)
		if filtered {
			return "", "", false
		}
	default:
		return "", "", false
	}
	if scope != "" && !filepath.IsAbs(scope) {
		scope = filepath.Join(ev.Cwd, scope)
	}
	return DefinitionName(pattern), scope, true
}

func codexSearchNoMatch(agent string, tool contract.Tool) bool {
	out := tool.Output
	return agent == "codex" && tool.Name == contract.ToolShell && out != nil &&
		!out.Interrupted && !out.Background && out.ExitCode != nil && *out.ExitCode == 1 &&
		strings.TrimSpace(out.Text) == ""
}

var searchResultPath = lazy(`^(?:[A-Za-z]:)?[^:\s\p{Cc}<>"|?*]*[./\\][^:\s\p{Cc}<>"|?*]+`)
var searchListFlag = lazy(`^(?:--files-with-matches|-[a-zA-Z]*l[a-zA-Z]*)$`)
var searchDiagnostic = lazy(`(?i)^(?:(?:rg|grep|egrep|fgrep|ag|ack)(?:\.exe)?\s*:|usage\s*:|(?:error|fatal)\s*:)|is not recognized|command not found|no such file or directory`)

// codexSearchHasResults admits headerless output only when every nonblank
// line looks like a path-labelled hit or a path from a file list. Shell
// diagnostics, plain text and silence cannot establish that a search ran.
func codexSearchHasResults(command string, out *contract.ToolOutput) bool {
	if !out.OK || out.Interrupted || out.Background || len(out.Text) > 64<<10 {
		return false
	}
	filesOnly := false
	for _, word := range shellparse.Words(shellparse.SearchSegment(command)) {
		if word == "--" {
			break
		}
		if searchListFlag().MatchString(word) {
			filesOnly = true
			break
		}
	}
	found := false
	for line := range strings.Lines(out.Text) {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		path := searchResultPath().FindString(line)
		if path == "" || searchDiagnostic().MatchString(line) {
			return false
		}
		suffix := line[len(path):]
		if !strings.HasPrefix(suffix, ":") && !(filesOnly && suffix == "") {
			return false
		}
		found = true
	}
	return found
}

// StudySpans uses exactly the live eligibility and source reader. It never
// opens hooks storage, so saved-session replay cannot advance an efficacy gate.
func StudySpans(ev contract.Event, env Environment) []SpanAnswer {
	var idx *index.Reader
	defer func() {
		if idx != nil {
			closeRescueIndex(env, idx)
		}
	}()
	tools := ev.Batch
	if ev.Tool != nil {
		tools = append([]contract.Tool{*ev.Tool}, tools...)
	}
	if len(tools) > 8 {
		tools = tools[:8]
	}
	for _, tool := range tools {
		name, scope, ok := spanPattern(ev, tool)
		if !ok || name == "" {
			continue
		}
		if idx == nil {
			idx = openRescueIndex(env, ev)
			if idx == nil {
				return nil
			}
		}
		// Count before fresh lookup: a stale collision cannot disappear from uniqueness.
		if idx.DefinitionCount(name) != 1 {
			continue
		}
		hits, err := idx.SymbolsNamed(name)
		if err != nil || len(hits) != 1 {
			continue
		}
		hit := hits[0]
		signature := symbolSignature(ev.Checkout, hit)
		if !wordIn(signature, name) {
			continue
		}
		if !onDisk(ev.Checkout, hit.Path) || !withinScope(ev.Checkout, scope, hit.Path) {
			continue
		}
		body := readSymbol(ev.Checkout, hit, spanCharacters*4)
		signatureOnly := body == "" || utf8.RuneCountInString(body) > spanCharacters
		end := hit.End
		if signatureOnly {
			body = symbolSignature(ev.Checkout, hit)
			end = hit.Start
		}
		if body == "" || utf8.RuneCountInString(body) > spanCharacters {
			continue
		}
		if info, _ := idx.FileInfo(hit.Path); info == nil {
			continue
		}
		if spanReturned(tool.Output.Text, body) {
			continue
		}
		// Location and code together must fit the inline character ceiling.
		text := fmt.Sprintf("%s:%d-%d\n%s", hit.Path, hit.Start, end, body)
		if utf8.RuneCountInString(text) > spanCharacters {
			body = symbolSignature(ev.Checkout, hit)
			end = hit.Start
			signatureOnly = true
			text = fmt.Sprintf("%s:%d-%d %s", hit.Path, hit.Start, end, body)
			if body == "" || utf8.RuneCountInString(text) > spanCharacters || spanReturned(tool.Output.Text, body) {
				continue
			}
		}
		origin := ""
		if ev.Agent == "claude-code" && ev.Kind == contract.PostTool {
			origin = toolKey(tool)
		}
		head := ""
		if sig := symbolSignature(ev.Checkout, hit); sig != "" {
			head = fmt.Sprintf("%s:%d %s", hit.Path, hit.Start, sig)
			if searchShows(tool.Output.Text)(sig) {
				// The search showed the line: say where, not what.
				head = fmt.Sprintf("%s:%d %s", hit.Path, hit.Start, name)
			}
		}
		return []SpanAnswer{{Path: hit.Path, Start: hit.Start, End: end, Text: text, SignatureOnly: signatureOnly, Origin: origin, name: name, noisy: noisySearch(ev, tool), head: head, tool: tool}}
	}
	return nil
}

type SpanAnswer struct {
	Origin        string `json:"origin,omitempty"`
	Path          string `json:"path"`
	Start         int    `json:"start"`
	End           int    `json:"end"`
	Text          string `json:"text"`
	SignatureOnly bool   `json:"signature_only"`
	// name is the definition's name; noisy marks a search grep alone didn't
	// settle (hits in several files), where the graph's lines are added.
	name  string
	noisy bool
	// head is the span as one line, location and signature, for when the
	// graph's lines need the room; tool is the search it answers.
	head string
	tool contract.Tool
}

// Strip only search/read line labels. Comparing complete lines prevents a hit
// containing a short signature substring from hiding an otherwise useful body.
var resultLabelRE = lazy(`^(?:(?:[A-Za-z]:)?[^\n]*?[:-][0-9]+[:-]|\s*[0-9]+[\t→:])`)

func spanReturned(output, body string) bool {
	if len(output) > 1<<20 {
		// Abstain when bounded duplicate detection cannot prove a useful addition.
		return true
	}
	var normalized []string
	for _, line := range strings.Split(strings.ReplaceAll(output, "\r\n", "\n"), "\n") {
		normalized = append(normalized, strings.TrimSpace(resultLabelRE().ReplaceAllString(line, "")))
	}
	var wanted []string
	for _, line := range strings.Split(body, "\n") {
		wanted = append(wanted, strings.TrimSpace(line))
	}
	return strings.Contains("\n"+strings.Join(normalized, "\n")+"\n", "\n"+strings.Join(wanted, "\n")+"\n")
}

func searchCards(ev contract.Event, env Environment) []answerCard {
	if !searchEvent(ev) {
		return nil
	}
	spanMode := surfaceSetting(env, ev.ProjectID, "search-span")
	graphOn := ev.ProjectID != "" && ev.Checkout != "" && surfaceSetting(env, ev.ProjectID, graphCardSurface) != "off"
	if spanMode == "off" && !graphOn {
		return nil
	}
	var view graph.View
	var done func()
	defer func() {
		if done != nil {
			done()
		}
	}()
	opened := false
	open := func() bool {
		if !opened {
			opened = true
			view, done = graphView(ev, env)
		}
		return done != nil
	}
	var out []answerCard
	spans := StudySpans(ev, env)
	for _, span := range spans {
		card := answerCard{surface: "search-span", text: span.Text, target: record.SurfaceTarget{Paths: []string{span.Path}, Start: span.Start, End: span.End, Origin: span.Origin}, symPath: span.Path, symName: span.name}
		if span.noisy && graphOn && open() {
			// One card: the definition, then the graph's callers and test. The
			// whole body when the span card is on and there's room, else the
			// definition's line. It is the graph's card then, on by default.
			output := ""
			if span.tool.Output != nil {
				output = span.tool.Output.Text
			}
			heads := []string{span.head}
			if spanMode == "on" && !span.SignatureOnly {
				heads = []string{span.Text, span.head}
			}
			for _, head := range heads {
				if head == "" {
					continue
				}
				if lines, value, ok := graphSearchLines(ev, env, view, span, head, output); ok {
					card.text, card.surface = head+"\n"+lines, graphCardSurface
					card.value, card.detail = value, "search"
					break
				}
			}
		}
		if card.surface == "search-span" && spanMode == "off" {
			continue
		}
		card.id = "mex:span:" + contentHash(card.text)[7:31]
		out = append(out, card)
	}
	if len(out) == 0 && graphOn {
		// No span card: the search already showed the definition, or it was
		// too long. The graph's card can still save the reads that follow.
		tools := ev.Batch
		if ev.Tool != nil {
			tools = append([]contract.Tool{*ev.Tool}, tools...)
		}
		for i, tool := range tools {
			if i >= 8 {
				break
			}
			if tool.Name != contract.ToolSearch && tool.Name != contract.ToolShell {
				continue
			}
			if name, _, ok := spanPattern(ev, tool); !ok || name == "" || !noisySearch(ev, tool) || !open() {
				continue
			}
			if card, ok := graphSearchCard(ev, env, view, tool); ok {
				out = append(out, card)
				break
			}
		}
	}
	return out
}
