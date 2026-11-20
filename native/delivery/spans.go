package delivery

import (
	"fmt"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/internal/shellparse"
	"github.com/mex-memory/mex/native/record"
)

const spanCharacters = 600

// noisySearchFiles: a search with hits in this many files is one grep didn't
// settle; symbol help pays only on such names.
const noisySearchFiles = 3

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
		return false
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
	if tool.Output == nil || !tool.Output.OK {
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
		if ev.Agent == "codex" && tool.Output.ExitCode == nil {
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
		_, _, _, files, lines, searched := searchResult(ev, tool)
		noisy := searched && (len(files) >= noisySearchFiles || lines >= rescueWideMax)
		return []SpanAnswer{{Path: hit.Path, Start: hit.Start, End: end, Text: text, SignatureOnly: signatureOnly, Origin: origin, name: name, noisy: noisy}}
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
	if !searchEvent(ev) || surfaceSetting(env, ev.ProjectID, "search-span") == "off" {
		return nil
	}
	spans := StudySpans(ev, env)
	var out []answerCard
	for _, span := range spans {
		card := answerCard{surface: "search-span", text: span.Text, target: record.SurfaceTarget{Paths: []string{span.Path}, Start: span.Start, End: span.End, Origin: span.Origin}}
		if span.noisy {
			// One card: the definition, then the graph's callers and test.
			if lines, value, ok := graphSearchLines(ev, env, span); ok {
				card.text += "\n" + lines
				card.value, card.detail = value, "graph"
			}
		}
		card.id = "mex:span:" + contentHash(card.text)[7:31]
		out = append(out, card)
	}
	return out
}
