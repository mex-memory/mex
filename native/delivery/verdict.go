package delivery

import (
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/index"
)

// Verdicts as the evaluator stores them; a missing row is unknown.
const (
	held    = "held"
	changed = "changed"
	broken  = "broken"
	unknown = "unknown"
)

// shaped is a candidate after the verdict decided what reaches the model.
type shaped struct {
	candidate
	verdict   string
	action    string // given, replaced, withheld
	full      string // text for the full form ("" when only one form exists)
	oneLine   string
	fullTok   int
	lineTok   int
	hashText  string // what the content hash covers
	detail    string // stable receipt reason, never canonical entry text
	conflicts []string
}

// shapeEnv gives the verdict stage what it may read: the checkout's files and
// the file index, both bounded.
type shapeEnv struct {
	recordDirectory string
	project         string
	checkout        string
	index           *index.Reader
	indexTried      bool
}

func (s *shapeEnv) reader() *index.Reader {
	if !s.indexTried {
		s.indexTried = true
		if r, err := index.Open(s.recordDirectory, s.project, s.checkout); err == nil {
			s.index = r
		}
	}
	return s.index
}

func (s *shapeEnv) close() {
	if s.index != nil {
		_ = s.index.Close()
	}
}

// shape applies the sheet 40 table: what each kind becomes under each verdict.
// Nothing ever goes out with a warning label: a stale entry is a pointer,
// re-derived, or withheld.
func shape(c candidate, verdict string, env *shapeEnv) shaped {
	it := c.item
	s := shaped{candidate: c, verdict: verdict, action: "given", full: it.Full, oneLine: it.OneLine, fullTok: it.FullTokens, lineTok: it.OneLineTokens}
	withhold := func() shaped { s.action, s.full, s.oneLine, s.fullTok, s.lineTok = "withheld", "", "", 0, 0; return s }
	kind := it.Entry.Kind
	if it.Level == "personal" {
		if verdict == broken {
			return withhold()
		}
		return s
	}
	if it.Level == "hint" || kind == "hint" {
		// An observed hint carries no checks, so its verdict is unknown; the
		// Node side's mirror, which already gated it, vouches for its source.
		// Any check that does run and doubts it withholds it.
		if verdict == held || verdict == unknown {
			return s
		}
		return withhold()
	}
	switch kind {
	case "fact":
		switch verdict {
		case held:
			return s
		case broken:
			return withhold()
		default: // changed, or unknown: point at today's code, never restate it
			text, ok := pointer(it.Entry, env)
			if !ok {
				return withhold()
			}
			s.action, s.full, s.oneLine = "replaced", text, text
			s.fullTok = entries.EstimateTokens(text)
			s.lineTok = s.fullTok
			return s
		}
	case "recipe":
		if verdict == held {
			return s
		}
		if verdict == unknown && recipeCommandExists(it.Entry, env.checkout) {
			return s
		}
		full, line, ok := rederive(it, env.checkout)
		if !ok {
			if verdict == unknown || verdict == changed {
				// Nothing to re-derive from: a changed recipe whose command
				// still exists is still the recipe.
				if recipeCommandExists(it.Entry, env.checkout) {
					return s
				}
			}
			return withhold()
		}
		s.action, s.full, s.oneLine = "replaced", full, line
		s.fullTok, s.lineTok = entries.EstimateTokens(full), entries.EstimateTokens(line)
		return s
	default: // rule, decision, pitfall, procedure
		if verdict == broken {
			return withhold()
		}
		return s
	}
}

// pointer names where today's code is, from the entry's own checks. It never
// repeats the stale claim. No location found means no pointer.
func pointer(e *entries.Entry, env *shapeEnv) (string, bool) {
	for _, c := range e.Checks {
		file, _ := c.Target["file"].(string)
		if file == "" || strings.Contains(file, "..") {
			continue
		}
		info, err := os.Stat(filepath.Join(env.checkout, filepath.FromSlash(file)))
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		symbol, _ := c.Target["symbol"].(string)
		if symbol != "" {
			if r := env.reader(); r != nil {
				if out, miss := r.Outline(file); miss == nil {
					parts := strings.Split(symbol, ".")
					for i, s := range out.Symbols {
						if s.Name != parts[len(parts)-1] || !parentsMatch(out.Symbols, i, parts) {
							continue
						}
						return fmt.Sprintf("MEX has a note on `%s`; the code changed since. Current code: `%s:%d-%d`.", symbol, file, s.Start, s.End), true
					}
				}
			}
			// The symbol can't be placed: point at the file only when the
			// name is still in it.
			if data, err := readBounded(filepath.Join(env.checkout, filepath.FromSlash(file)), 2<<20); err == nil && strings.Contains(string(data), parts0(symbol)) {
				return fmt.Sprintf("MEX has a note on `%s`; the code changed since. Current code: `%s`.", symbol, file), true
			}
			continue
		}
		return fmt.Sprintf("MEX has a note on `%s`; it changed since. Current version: `%s`.", path.Base(file), file), true
	}
	return "", false
}

func parts0(symbol string) string { return symbol[strings.LastIndex(symbol, ".")+1:] }

func parentsMatch(symbols []index.Symbol, i int, parts []string) bool {
	at := symbols[i].Parent
	for j := len(parts) - 2; j >= 0; j-- {
		if at == nil || *at < 0 || *at >= len(symbols) || symbols[*at].Name != parts[j] {
			return false
		}
		at = symbols[*at].Parent
	}
	return true
}

func readBounded(p string, max int64) ([]byte, error) {
	info, err := os.Stat(p)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > max {
		return nil, os.ErrInvalid
	}
	return os.ReadFile(p)
}

// manifestScripts reads one package manifest's script names.
func manifestScripts(file string) (map[string]string, bool) {
	data, err := readBounded(file, 1<<20)
	if err != nil {
		return nil, false
	}
	var m struct {
		Scripts map[string]string `json:"scripts"`
	}
	if json.Unmarshal(data, &m) != nil {
		return nil, false
	}
	return m.Scripts, true
}

// recipeScript is the manifest file and script name a recipe's command check
// names, e.g. package.json and test:unit.
func recipeScript(e *entries.Entry) (file, script, run string) {
	for _, c := range e.Checks {
		if c.Kind != "command" {
			continue
		}
		run, _ = c.Target["run"].(string)
		file, _ = c.Target["file"].(string)
		ptr, _ := c.Target["pointer"].(string)
		if strings.HasPrefix(ptr, "/scripts/") {
			script = strings.ReplaceAll(strings.ReplaceAll(strings.TrimPrefix(ptr, "/scripts/"), "~1", "/"), "~0", "~")
		}
		if script == "" && run != "" {
			if w := normalizeCommand(run); len(w) >= 2 && w[0] == "pm" {
				script = w[1]
			}
		}
		return
	}
	return "", "", ""
}

func recipeCommandExists(e *entries.Entry, checkout string) bool {
	file, script, _ := recipeScript(e)
	if script == "" || !strings.HasSuffix(file, "package.json") {
		return false
	}
	scripts, ok := manifestScripts(filepath.Join(checkout, filepath.FromSlash(file)))
	_, exists := scripts[script]
	return ok && exists
}

// rederive matches a recipe whose script is gone against today's scripts,
// using the recipe's own words: the old script name's parts and the words of
// its text. Deterministic and bounded (at most 64 manifests). It answers only
// when one script wins clearly.
func rederive(it *entries.Item, checkout string) (full, line string, ok bool) {
	e := it.Entry
	file, script, run := recipeScript(e)
	if script == "" || run == "" || !strings.HasSuffix(file, "package.json") {
		return "", "", false
	}
	want := nameParts(script)
	textWords := map[string]bool{}
	for _, w := range strings.FieldsFunc(strings.ToLower(e.OneLine+" "+e.Text), func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9')
	}) {
		textWords[w] = true
	}
	type option struct {
		dir, name string
		score     float64
	}
	var options []option
	manifests := []string{file}
	for _, pattern := range []string{"packages/*/package.json", "apps/*/package.json", "libs/*/package.json", "services/*/package.json"} {
		matches, _ := filepath.Glob(filepath.Join(checkout, filepath.FromSlash(pattern)))
		sort.Strings(matches)
		for _, m := range matches {
			if r, ok := relTo(slash(checkout), slash(m)); ok && r != file {
				manifests = append(manifests, r)
			}
			if len(manifests) >= 64 {
				break
			}
		}
	}
	for _, mf := range manifests {
		scripts, ok := manifestScripts(filepath.Join(checkout, filepath.FromSlash(mf)))
		if !ok {
			continue
		}
		for name := range scripts {
			if mf == file && name == script {
				return "", "", false // still there: nothing to re-derive
			}
			got := nameParts(name)
			score := overlap(want, got)
			for _, p := range got {
				if textWords[p] && !contains(want, p) {
					score += 0.25
				}
			}
			if mf == file {
				score += 0.1 // prefer the same manifest
			}
			options = append(options, option{path.Dir(mf), name, score})
		}
	}
	sort.Slice(options, func(i, j int) bool {
		if options[i].score != options[j].score {
			return options[i].score > options[j].score
		}
		return options[i].dir+options[i].name < options[j].dir+options[j].name
	})
	if len(options) == 0 || options[0].score < 0.6 || (len(options) > 1 && options[0].score-options[1].score < 0.2) {
		return "", "", false
	}
	best := options[0]
	newRun := strings.Replace(run, script, best.name, 1)
	if best.dir != "." && best.dir != path.Dir(file) {
		newRun = "cd " + best.dir + " && " + newRun
	}
	replace := func(s string) string {
		s = strings.ReplaceAll(s, run, newRun)
		return strings.ReplaceAll(s, "`"+script+"`", "`"+best.name+"`")
	}
	label := strings.TrimSpace(strings.TrimSuffix(it.OneLine, e.OneLine))
	line = label + " " + replace(e.OneLine)
	if !strings.Contains(line, newRun) {
		line += " Run: `" + newRun + "`."
	}
	full = label + " " + replace(e.Text)
	if !strings.Contains(full, newRun) {
		full += " Run: `" + newRun + "`."
	}
	return full, line, true
}

func nameParts(name string) []string {
	return strings.FieldsFunc(strings.ToLower(name), func(r rune) bool { return r == ':' || r == '-' || r == '_' || r == '/' || r == '.' })
}

func overlap(a, b []string) float64 {
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	n := 0
	for _, x := range a {
		if contains(b, x) {
			n++
		}
	}
	union := len(a) + len(b) - n
	return float64(n) / float64(union)
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
