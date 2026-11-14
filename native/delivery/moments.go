package delivery

import (
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/internal/contract"
)

// Trigger strength tiers (sheet 30, ranking step 2). Lower is stronger.
const (
	tierPattern = 1 // exact anti-pattern, failure signature, rejected option in code
	tierCommand = 2 // the recipe's own command
	tierFile    = 3 // a scope naming the file itself
	tierFolder  = 4 // a scope over a folder
	tierPrompt  = 5 // words in the prompt
)

// Moment names stored in deliveries.moment.
const (
	momentRead     = "read"
	momentReadRisk = "read-risk"
	momentEdit     = "edit"
	momentCommand  = "command"
	momentFailure  = "failure"
	momentRejected = "rejected"
	momentCreate   = "create"
	momentPrompt   = "prompt"
)

// toolView is one tool call reduced to what moments need, with the repo
// resolved from the touched file (or the command's folder), never the shell's.
type toolView struct {
	name     contract.ToolName
	path     string // absolute, forward slashes
	rel      string // relative to the checkout, forward slashes
	command  string
	added    string // text the call adds: edit new, write content, patch additions
	created  bool
	failed   bool
	output   *contract.ToolOutput
	project  string
	checkout string
}

type candidate struct {
	item    *entries.Item
	moment  string
	tier    int
	exempt  bool // exact matches: never held back by the budget
	reserve bool // failure fixes and corrections use the reserved lane
	rel     string
}

// Resolver finds the registered checkout for a path. isFile is false for a
// folder (a command's working folder).
type Resolver func(path string, isFile bool) (project, checkout string)

func slash(p string) string { return strings.ReplaceAll(p, "\\", "/") }

func relTo(checkout, p string) (string, bool) {
	if checkout == "" || p == "" {
		return "", false
	}
	r, err := filepath.Rel(filepath.FromSlash(checkout), filepath.FromSlash(p))
	if err != nil {
		return "", false
	}
	r = slash(r)
	if r == ".." || strings.HasPrefix(r, "../") || filepath.IsAbs(r) {
		return "", false
	}
	if r == "." {
		r = ""
	}
	return r, true
}

// views turns the event's tools into toolViews, each in its own repo.
func views(ev contract.Event, resolve Resolver) []toolView {
	tools := ev.Batch
	if ev.Tool != nil {
		tools = append([]contract.Tool{*ev.Tool}, tools...)
	}
	if len(tools) > 64 {
		tools = tools[:64]
	}
	var out []toolView
	for i := range tools {
		t := tools[i]
		base := toolView{name: t.Name, output: t.Output, project: ev.ProjectID, checkout: ev.Checkout}
		base.failed = ev.Kind == contract.PostToolFailure || (t.Output != nil && codexFailed(base))
		switch t.Name {
		case contract.ToolShell:
			base.command = t.Input.Command
			folder := slash(ev.Cwd)
			if d := cdTarget(t.Input.Command); d != "" {
				if filepath.IsAbs(filepath.FromSlash(d)) {
					folder = slash(d)
				} else if folder != "" {
					folder = slash(filepath.Join(filepath.FromSlash(folder), filepath.FromSlash(d)))
				}
			}
			if folder != "" {
				base.path = folder
				if resolve != nil {
					base.project, base.checkout = resolve(folder, false)
				}
			}
			out = append(out, base)
		case contract.ToolPatch:
			for _, f := range t.Input.Files {
				v := base
				v.path = slash(f.Path)
				var b strings.Builder
				for _, h := range f.Hunks {
					b.WriteString(h.New)
					b.WriteByte('\n')
				}
				v.added = b.String()
				v.created = f.Kind == "add"
				if resolve != nil {
					v.project, v.checkout = resolve(v.path, true)
				}
				out = append(out, v)
			}
		default:
			if t.Input.Path == "" {
				continue
			}
			base.path = slash(t.Input.Path)
			switch t.Name {
			case contract.ToolEdit:
				if t.Input.New != nil {
					base.added = *t.Input.New
				}
			case contract.ToolWrite:
				if t.Input.Content != nil {
					base.added = *t.Input.Content
				}
				base.created = writeCreated(t)
			}
			if resolve != nil {
				base.project, base.checkout = resolve(base.path, t.Name != contract.ToolSearch && t.Name != contract.ToolGlob)
			}
			out = append(out, base)
		}
	}
	for i := range out {
		out[i].rel, _ = relTo(out[i].checkout, out[i].path)
		if out[i].checkout == "" {
			out[i].project = ""
		}
	}
	return out
}

// writeCreated reads the creation fact from the payload. Claude's Write tool
// reports `"type":"create"` (structured) or "File created successfully"
// (the text the model saw in a batch). Before the tool runs, a missing file
// means the call creates it.
func writeCreated(t contract.Tool) bool {
	if t.Output == nil {
		_, err := os.Lstat(filepath.FromSlash(t.Input.Path))
		return os.IsNotExist(err)
	}
	text := t.Output.Text
	if len(text) > 4096 {
		text = text[:4096]
	}
	return strings.Contains(text, `"type":"create"`) || strings.Contains(text, "File created successfully")
}

func inScope(item *entries.Item, rel string) bool {
	for _, re := range item.Scopes {
		if re.MatchString(rel) {
			return true
		}
	}
	return false
}

// scopeTier is tierFile when a scope names exactly this file, else tierFolder.
func scopeTier(item *entries.Item, rel string) int {
	for _, s := range item.Entry.Scope {
		if s == rel {
			return tierFile
		}
	}
	return tierFolder
}

// folderInScope accepts a command's folder when an entry's scope covers it or
// anything under it: a recipe for `apps/api/**` applies inside apps/api.
func folderInScope(item *entries.Item, rel string) bool {
	if rel == "" {
		return true
	}
	for _, s := range item.Entry.Scope {
		if s == "**" || s == "**/*" {
			return true
		}
		base := strings.TrimSuffix(strings.TrimSuffix(s, "/**"), "/*")
		if base == rel || strings.HasPrefix(rel+"/", base+"/") || strings.HasPrefix(base+"/", rel+"/") {
			return true
		}
	}
	return inScope(item, rel+"/x")
}

func triggers(item *entries.Item, kind string) []entries.Trigger {
	var out []entries.Trigger
	for _, w := range item.Entry.When {
		if w.Type == kind && w.Match == "literal" && strings.TrimSpace(w.Pattern) != "" {
			out = append(out, w)
		}
	}
	return out
}

func containsAny(text string, ts []entries.Trigger) bool {
	for _, t := range ts {
		if strings.Contains(text, t.Pattern) {
			return true
		}
	}
	return false
}

// recipeCommands are the commands a recipe runs: its command checks first,
// then commands quoted in backticks in its one-line form.
func recipeCommands(e *entries.Entry) []string {
	var out []string
	for _, c := range e.Checks {
		if c.Kind == "command" {
			if run, ok := c.Target["run"].(string); ok && run != "" {
				out = append(out, run)
			}
		}
	}
	if len(out) == 0 {
		for _, s := range backticked(e.OneLine) {
			if len(normalizeCommand(s)) >= 2 {
				out = append(out, s)
			}
		}
	}
	return out
}

var backtickRE = lazy("`([^`\n]{2,200})`")

func backticked(s string) []string {
	var out []string
	for _, m := range backtickRE().FindAllStringSubmatch(s, 8) {
		out = append(out, m[1])
	}
	return out
}

var generatedRE = lazy(`(?i)\b(generated|auto-generated|do not edit|codegen)\b`)

// promptWords are the build intents that bring a recipe to the first prompt.
var promptWordRE = lazy(`(?i)\b(test|tests|testing|build|lint|typecheck|type-check|format|migrate|deploy|bench|benchmark)\b`)

// moments finds the candidates for one tool call in one snapshot.
func moments(v toolView, snap *entries.Snapshot, hintOK func(*entries.Item) bool) []candidate {
	var out []candidate
	readText := ""
	if v.name == contract.ToolRead && v.output != nil {
		readText = v.output.Text
		if len(readText) > 1<<20 {
			readText = readText[:1<<20]
		}
	}
	var failLines []string
	if v.failed && v.output != nil {
		failLines = failureLines(v.output.Text)
	}
	for i := range snap.Items {
		it := &snap.Items[i]
		if it.NeedsHintGate && (hintOK == nil || !hintOK(it)) {
			continue
		}
		e := it.Entry
		add := func(moment string, tier int, exempt, reserve bool) {
			out = append(out, candidate{item: it, moment: moment, tier: tier, exempt: exempt, reserve: reserve, rel: v.rel})
		}
		switch v.name {
		case contract.ToolRead:
			if v.checkout == "" || !inScope(it, v.rel) {
				continue
			}
			switch e.Kind {
			case "pitfall":
				add(momentRead, scopeTier(it, v.rel), false, false)
			case "rule":
				if ts := triggers(it, "anti"); len(ts) > 0 && readText != "" && containsAny(readText, ts) {
					add(momentReadRisk, tierPattern, true, false)
				}
			}
		case contract.ToolEdit, contract.ToolWrite, contract.ToolPatch:
			if v.checkout == "" {
				continue
			}
			switch e.Kind {
			case "pitfall":
				if inScope(it, v.rel) && generatedRE().MatchString(e.OneLine+" "+e.Text) {
					add(momentEdit, scopeTier(it, v.rel), false, false)
				}
			case "decision":
				if ts := triggers(it, "rejected"); len(ts) > 0 && v.added != "" && containsAny(v.added, ts) && (inScope(it, v.rel) || isManifest(v.rel)) {
					add(momentRejected, tierPattern, true, false)
				}
			case "procedure":
				if v.created && createsMatch(it, v.rel) {
					add(momentCreate, tierFile, false, false)
				}
			}
		case contract.ToolShell:
			if v.checkout == "" {
				continue
			}
			if v.failed && e.Kind == "hint" && folderInScope(it, v.rel) {
				for _, t := range triggers(it, "anti") {
					if signatureMatches(failLines, t.Pattern) {
						add(momentFailure, tierPattern, true, true)
						break
					}
				}
			}
			if e.Kind == "recipe" && v.command != "" && folderInScope(it, v.rel) {
				for _, c := range recipeCommands(e) {
					if commandMatches(v.command, c) {
						add(momentCommand, tierCommand, false, false)
						break
					}
				}
			}
		}
	}
	return out
}

// promptMoments: a typed prompt that names a rejected option brings its
// decision; one that asks to test or build brings the matching recipe.
func promptMoments(text string, snap *entries.Snapshot) []candidate {
	var out []candidate
	if len(text) > 32*1024 {
		text = text[:32*1024]
	}
	intents := map[string]bool{}
	for _, m := range promptWordRE().FindAllString(text, 16) {
		intents[stem(strings.ToLower(m))] = true
	}
	for i := range snap.Items {
		it := &snap.Items[i]
		if it.NeedsHintGate {
			continue
		}
		switch it.Entry.Kind {
		case "decision":
			for _, t := range triggers(it, "rejected") {
				if len(t.Pattern) >= 3 && wordIn(text, t.Pattern) {
					out = append(out, candidate{item: it, moment: momentPrompt, tier: tierPrompt})
					break
				}
			}
		case "recipe":
			if len(intents) == 0 {
				continue
			}
			for _, c := range recipeCommands(it.Entry) {
				w := normalizeCommand(c)
				hit := false
				for _, part := range w[1:] {
					for _, piece := range strings.FieldsFunc(strings.ToLower(part), func(r rune) bool { return r == ':' || r == '-' || r == '_' || r == '/' }) {
						if intents[stem(piece)] {
							hit = true
						}
					}
				}
				if hit {
					out = append(out, candidate{item: it, moment: momentPrompt, tier: tierPrompt})
					break
				}
			}
		}
	}
	return out
}

func stem(w string) string {
	switch w {
	case "tests", "testing":
		return "test"
	case "type-check":
		return "typecheck"
	case "benchmark":
		return "bench"
	}
	return w
}

func wordIn(text, word string) bool {
	re, err := regexp.Compile(`(?i)(^|[^A-Za-z0-9_])` + regexp.QuoteMeta(word) + `($|[^A-Za-z0-9_])`)
	return err == nil && re.MatchString(text)
}

var manifests = map[string]bool{"package.json": true, "go.mod": true, "Cargo.toml": true, "pyproject.toml": true, "requirements.txt": true, "Gemfile": true, "pom.xml": true, "build.gradle": true, "composer.json": true}

func isManifest(rel string) bool { return manifests[path.Base(rel)] }

// createsMatch uses `when: creates` globs when the procedure has them, else
// its scope.
func createsMatch(it *entries.Item, rel string) bool {
	ts := triggers(it, "creates")
	if len(ts) == 0 {
		for _, w := range it.Entry.When {
			if w.Type == "creates" && strings.TrimSpace(w.Pattern) != "" {
				ts = append(ts, w)
			}
		}
	}
	if len(ts) == 0 {
		return inScope(it, rel)
	}
	for _, t := range ts {
		if re, err := index.CompileGlob(t.Pattern); err == nil && re.MatchString(rel) {
			return true
		}
	}
	return false
}
