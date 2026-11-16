package delivery

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"unicode"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/internal/shellparse"
	"github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
)

// Rescues answer the moments agents most often get stuck on (a path that
// doesn't exist, a search that finds nothing, a glob that times out) with
// pointers from the file index. They need no knowledge entries. Each is
// silent on any doubt, and each starts in trial: shadow until its base rate
// is measured, then on only through the ledger's gate.

const (
	rescueMaxItems = 2
	// A search that returned this many result lines or more is not narrow.
	rescueWideMax = 14
	// A name defined in more files than this says nothing about where to look.
	rescueMaxDefinitions = 5
	globRescueMaxPaths   = 30
)

type rescue struct {
	surface           string
	project, checkout string
	text              string
	target            record.SurfaceTarget
}

var (
	missingFileText = sync.OnceValue(func() *regexp.Regexp {
		return regexp.MustCompile(`(?i)(does not exist|no such file|not found|cannot find (the )?(path|file)|could not find|ENOENT)`)
	})
	timeoutText = sync.OnceValue(func() *regexp.Regexp { return regexp.MustCompile(`(?i)(timed? ?out|timeout)`) })
)

var nonCode = map[string]bool{".md": true, ".mdx": true, ".txt": true, ".rst": true, ".json": true, ".yaml": true, ".yml": true, ".toml": true,
	".lock": true, ".log": true, ".csv": true, ".tsv": true, ".xml": true, ".html": true, ".ini": true, ".cfg": true, ".env": true}

// findRescue looks at one event for a moment a rescue answers. It does string
// work only; the index is opened only when a moment matched.
func findRescue(ev contract.Event, env Environment) *rescue {
	if ev.ProjectID == "" || ev.Checkout == "" || (ev.Agent != "claude-code" && ev.Agent != "codex") {
		return nil
	}
	tools := ev.Batch
	if ev.Tool != nil {
		tools = []contract.Tool{*ev.Tool}
	}
	if len(tools) > 16 {
		tools = tools[:16]
	}
	for _, tool := range tools {
		if tool.Output == nil || tool.Output.Interrupted {
			continue
		}
		var r *rescue
		switch {
		case ev.Kind == contract.PostToolFailure && tool.Name == contract.ToolGlob && timeoutText().MatchString(tool.Output.Text):
			r = globTimeoutRescue(ev, env, tool)
		case !tool.Output.OK:
			if file := missingFile(ev, tool); file != "" {
				r = wrongPathRescue(ev, env, file)
			}
		}
		if r == nil {
			// searchResult checks success itself: a Claude Code search must have
			// succeeded, a Codex search must have exited 0 or 1.
			r = searchRescue(ev, env, tool)
		}
		if r != nil {
			return r
		}
	}
	return nil
}

// rescueAllowed checks the surface's setting before any index work.
func rescueAllowed(env Environment, project, surface string) bool {
	return surfaceSetting(env, project, surface) != "off"
}

func openRescueIndex(env Environment, ev contract.Event) *index.Reader {
	r, err := index.Open(env.RecordDirectory, ev.ProjectID, ev.Checkout)
	if err != nil {
		return nil
	}
	return r
}

// missingFile is the absolute path a failed read or edit couldn't find, or "".
func missingFile(ev contract.Event, tool contract.Tool) string {
	text := tool.Output.Text
	if len(text) > 16384 {
		text = text[:16384]
	}
	if !missingFileText().MatchString(text) || strings.Contains(text, "Did you mean") {
		return ""
	}
	switch tool.Name {
	case contract.ToolRead, contract.ToolEdit:
		return tool.Input.Path
	case contract.ToolShell:
		reads := shellparse.Reads(tool.Input.Command, ev.Cwd, ev.Agent == "codex")
		if len(reads) == 1 {
			return reads[0].Path
		}
	}
	return ""
}

// relativeMissing makes a path that doesn't exist checkout-relative through
// its nearest existing folder. A path outside the checkout gives "".
func relativeMissing(checkout, file string) string {
	if file == "" || !filepath.IsAbs(file) {
		return ""
	}
	clean := filepath.Clean(file)
	rest := []string{}
	dir := clean
	for i := 0; i < 64; i++ {
		parent := filepath.Dir(dir)
		rest = append([]string{filepath.Base(dir)}, rest...)
		if parent == dir {
			return ""
		}
		dir = parent
		real, err := place.RealPath(dir)
		if err != nil {
			continue
		}
		prefix := ""
		if filepath.Clean(real) != filepath.Clean(checkout) {
			var ok bool
			if prefix, ok = place.RelativeToCheckout(checkout, real); !ok {
				return ""
			}
			prefix += "/"
		}
		rel := prefix + strings.Join(rest, "/")
		if strings.Contains("/"+rel+"/", "/../") {
			return ""
		}
		return rel
	}
	return ""
}

func onDisk(checkout, rel string) bool {
	info, err := os.Lstat(filepath.Join(checkout, filepath.FromSlash(rel)))
	return err == nil && info.Mode().IsRegular()
}

// sharedTail counts the trailing folder names two paths have in common.
func sharedTail(a, b string) int {
	x, y := strings.Split(path.Dir(a), "/"), strings.Split(path.Dir(b), "/")
	n := 0
	for n < len(x) && n < len(y) && x[len(x)-1-n] == y[len(y)-1-n] && x[len(x)-1-n] != "." {
		n++
	}
	return n
}

func wrongPathRescue(ev contract.Event, env Environment, file string) *rescue {
	if !rescueAllowed(env, ev.ProjectID, "rescue-wrong-path") {
		return nil
	}
	if _, err := os.Lstat(file); !os.IsNotExist(err) {
		return nil // the failure wasn't about a missing file
	}
	rel := relativeMissing(ev.Checkout, file)
	if rel == "" {
		return nil
	}
	idx := openRescueIndex(env, ev)
	if idx == nil {
		return nil
	}
	defer idx.Close()
	named, err := idx.FilesNamed(path.Base(rel))
	if err != nil {
		return nil
	}
	var found []string
	for _, p := range named {
		if p != rel && onDisk(ev.Checkout, p) {
			found = append(found, p)
		}
	}
	if len(found) > rescueMaxItems {
		// Keep only the paths closest to the one that failed; still ambiguous
		// after that means silence.
		best := 0
		for _, p := range found {
			best = max(best, sharedTail(p, rel))
		}
		var closest []string
		for _, p := range found {
			if sharedTail(p, rel) == best {
				closest = append(closest, p)
			}
		}
		found = closest
	}
	if len(found) == 0 || len(found) > rescueMaxItems {
		return nil
	}
	return &rescue{surface: "rescue-wrong-path", project: ev.ProjectID, checkout: ev.Checkout,
		text:   "No file at " + rel + ". Indexed files with that name: " + strings.Join(found, ", "),
		target: record.SurfaceTarget{Paths: found}}
}

func globTimeoutRescue(ev contract.Event, env Environment, tool contract.Tool) *rescue {
	pattern := strings.TrimSpace(tool.Input.Pattern)
	if pattern == "" || strings.ContainsAny(pattern, "{}") || len(pattern) > 512 || !rescueAllowed(env, ev.ProjectID, "rescue-glob-timeout") {
		return nil
	}
	glob := strings.TrimPrefix(filepath.ToSlash(pattern), "./")
	if filepath.IsAbs(pattern) {
		return nil
	}
	if tool.Input.Path != "" {
		real, err := place.RealPath(tool.Input.Path)
		if err != nil {
			return nil
		}
		if filepath.Clean(real) != filepath.Clean(ev.Checkout) {
			rel, ok := place.RelativeToCheckout(ev.Checkout, real)
			if !ok {
				return nil
			}
			glob = rel + "/" + glob
		}
	}
	idx := openRescueIndex(env, ev)
	if idx == nil {
		return nil
	}
	defer idx.Close()
	paths, more, err := idx.PathsMatching(glob, globRescueMaxPaths)
	if err != nil || len(paths) == 0 {
		return nil
	}
	head := "Glob " + glob + " timed out. Matches from the file index"
	if more {
		head += " (first " + strconv.Itoa(len(paths)) + ")"
	}
	return &rescue{surface: "rescue-glob-timeout", project: ev.ProjectID, checkout: ev.Checkout,
		text: head + ":\n" + strings.Join(paths, "\n"), target: record.SurfaceTarget{Paths: firstN(paths, 32)}}
}

func firstN(s []string, n int) []string {
	if len(s) > n {
		return s[:n]
	}
	return s
}

// searchTerms splits a pattern into identifier words: on non-letters and at
// case changes. "getUserId" and "user_id lookup" both give several terms.
func searchTerms(pattern string) []string {
	var out []string
	for _, part := range strings.FieldsFunc(pattern, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsDigit(r) }) {
		start := 0
		runes := []rune(part)
		for i := 1; i <= len(runes); i++ {
			if i == len(runes) || (unicode.IsUpper(runes[i]) && (unicode.IsLower(runes[i-1]) || (i+1 < len(runes) && unicode.IsLower(runes[i+1])))) {
				if w := strings.ToLower(string(runes[start:i])); len(w) >= 2 {
					out = append(out, w)
				}
				start = i
			}
		}
	}
	return out
}

// regexHeavy reports a pattern that is more expression than name.
func regexHeavy(pattern string) bool {
	if strings.ContainsAny(pattern, "()[]{}|*+?^$") {
		return true
	}
	for i := 0; i+1 < len(pattern); i++ {
		if pattern[i] == '\\' && pattern[i+1] != '.' {
			return true
		}
	}
	return false
}

// nameVariants spells the terms as code would: camelCase, PascalCase,
// snake_case and SCREAMING_SNAKE, with the pattern itself first.
func nameVariants(pattern string, terms []string) []string {
	title := func(w string) string { return strings.ToUpper(w[:1]) + w[1:] }
	camel, pascal := terms[0], title(terms[0])
	for _, w := range terms[1:] {
		camel += title(w)
		pascal += title(w)
	}
	snake := strings.Join(terms, "_")
	out := []string{}
	for _, v := range []string{strings.TrimSpace(pattern), camel, pascal, snake, strings.ToUpper(snake)} {
		ok := v != ""
		for _, r := range v {
			ok = ok && (unicode.IsLetter(r) || unicode.IsDigit(r) || r == '_' || r == '$')
		}
		if ok && !contains(out, v) {
			out = append(out, v)
		}
	}
	return out
}

// searchResult reads what a search tool returned: whether it found nothing,
// and the checkout-relative files of the result lines.
func searchResult(ev contract.Event, tool contract.Tool) (pattern, scope string, zero bool, files []string, lines int, ok bool) {
	text := strings.TrimSpace(tool.Output.Text)
	cwd := ev.Cwd
	switch tool.Name {
	case contract.ToolSearch, contract.ToolGlob:
		if ev.Agent != "claude-code" || !tool.Output.OK {
			return
		}
		if tool.Input.Filter != "" {
			return // a filtered search names its own files; a rescue can't honour the filter
		}
		pattern, scope = tool.Input.Pattern, tool.Input.Path
		zero = text == "" || text == "No matches found" || text == "No files found" || strings.HasPrefix(text, "Found 0 ")
	case contract.ToolShell:
		if ev.Agent != "codex" || shellparse.SearchSegment(tool.Input.Command) == "" || tool.Output.ExitCode == nil {
			return
		}
		pattern = shellparse.SearchPattern(tool.Input.Command)
		cwd = shellparse.SearchCwd(tool.Input.Command, cwd)
		var filtered bool
		if scope, filtered = shellSearchScope(tool.Input.Command, pattern, cwd); filtered {
			return
		}
		switch *tool.Output.ExitCode {
		case 1:
			zero = text == ""
			if !zero {
				return
			}
		case 0:
		default:
			return
		}
	default:
		return
	}
	if pattern == "" || len(pattern) > 256 {
		return
	}
	if !zero {
		for _, line := range strings.Split(text, "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "Found ") || line == "--" {
				continue
			}
			lines++
			if lines >= rescueWideMax {
				return pattern, scope, false, nil, lines, true
			}
			file := line
			// "path:line:text" or "path:count"; a drive letter's colon is part of the path.
			from := 0
			if len(file) > 2 && file[1] == ':' {
				from = 2
			}
			if i := strings.IndexByte(file[from:], ':'); i >= 0 {
				file = file[:from+i]
			}
			if !filepath.IsAbs(file) {
				file = shellparse.Resolve(cwd, file)
			}
			if rel, ok := place.RelativeToCheckout(ev.Checkout, file); ok && !contains(files, rel) {
				files = append(files, rel)
			}
		}
	}
	return pattern, scope, zero, files, lines, true
}

func searchRescue(ev contract.Event, env Environment, tool contract.Tool) *rescue {
	pattern, scope, zero, files, lines, ok := searchResult(ev, tool)
	if !ok || (!zero && (lines == 0 || lines >= rescueWideMax)) {
		return nil
	}
	surface := "rescue-search"
	if !zero {
		surface = "rescue-wide"
	}
	if tool.Name == contract.ToolGlob {
		if !zero {
			return nil
		}
		return globZeroRescue(ev, env, pattern)
	}
	terms := searchTerms(pattern)
	if len(terms) < 2 || regexHeavy(pattern) {
		return nil
	}
	if scope != "" {
		if info, err := os.Stat(scope); err == nil && info.Mode().IsRegular() && nonCode[strings.ToLower(filepath.Ext(scope))] {
			return nil
		}
	}
	if !rescueAllowed(env, ev.ProjectID, surface) {
		return nil
	}
	idx := openRescueIndex(env, ev)
	if idx == nil {
		return nil
	}
	defer idx.Close()
	type hit struct {
		name string
		index.SymbolHit
	}
	var hits []hit
	for _, name := range nameVariants(pattern, terms) {
		found, err := idx.SymbolsNamed(name)
		if err != nil || len(found) == 0 {
			continue
		}
		distinct := map[string]bool{}
		for _, h := range found {
			distinct[h.Path] = true
		}
		if len(distinct) > rescueMaxDefinitions {
			continue
		}
		// Only definitions inside what the search covered: an empty search is
		// rescued by a spelling it missed there, and a definition elsewhere
		// is a guess about intent.
		for _, h := range found {
			if withinScope(ev.Checkout, scope, h.Path) {
				hits = append(hits, hit{name, h})
			}
		}
		if len(hits) > 0 {
			break // the best spelling that names something here decides
		}
	}
	if len(hits) == 0 {
		return nil
	}
	sort.SliceStable(hits, func(i, j int) bool { return hits[i].Path < hits[j].Path })
	if !zero {
		// The wide rescue speaks only when the best definition is in a file
		// the search didn't return: a set difference, not a count.
		if contains(files, hits[0].Path) {
			return nil
		}
		hits = hits[:1]
	}
	var shown []string
	target := record.SurfaceTarget{}
	for _, h := range hits {
		if len(shown) == rescueMaxItems {
			break
		}
		if !onDisk(ev.Checkout, h.Path) {
			continue
		}
		shown = append(shown, h.Path+":"+strconv.Itoa(h.Start)+" "+h.Kind+" "+h.name)
		if !contains(target.Paths, h.Path) {
			target.Paths = append(target.Paths, h.Path)
		}
		if !contains(target.Names, h.name) {
			target.Names = append(target.Names, h.name)
		}
	}
	if len(shown) == 0 {
		return nil
	}
	head := "No matches for " + strconvQuote(pattern) + ". Indexed definitions: "
	if !zero {
		head = "Not in these results, defined at: "
	}
	return &rescue{surface: surface, project: ev.ProjectID, checkout: ev.Checkout, text: head + strings.Join(shown, "; "), target: target}
}

func globZeroRescue(ev contract.Event, env Environment, pattern string) *rescue {
	base := path.Base(filepath.ToSlash(pattern))
	if base == "" || strings.ContainsAny(base, "*?[]{}") || !rescueAllowed(env, ev.ProjectID, "rescue-search") {
		return nil
	}
	idx := openRescueIndex(env, ev)
	if idx == nil {
		return nil
	}
	defer idx.Close()
	named, err := idx.FilesNamed(base)
	if err != nil {
		return nil
	}
	var found []string
	for _, p := range named {
		if onDisk(ev.Checkout, p) {
			found = append(found, p)
		}
	}
	if len(found) == 0 || len(found) > rescueMaxItems {
		return nil
	}
	return &rescue{surface: "rescue-search", project: ev.ProjectID, checkout: ev.Checkout,
		text: "No matches for " + strconvQuote(pattern) + ". Indexed files named " + base + ": " + strings.Join(found, ", "), target: record.SurfaceTarget{Paths: found}}
}

func strconvQuote(s string) string { return strconv.Quote(s) }

// deliverRescue records the rescue through the ledger and renders it only if
// it was sent: a shadow or trial-shadow firing writes its receipt and stays silent.
func deliverRescue(h *record.Hooks, ev contract.Event, env Environment, r *rescue) (string, error) {
	sum := sha256.Sum256([]byte(r.surface + "\x00" + r.text))
	req := baseRequest(ev, env, r.project, r.checkout)
	req.Candidates = []record.DeliveryCandidate{{EntryID: "mex:rescue:" + hex.EncodeToString(sum[:8]), Moment: "rescue", Surface: r.surface, Form: "pointer", Action: "given",
		Tokens: entries.EstimateTokens(r.text), ContentHash: hex.EncodeToString(sum[:]), Target: r.target, Title: firstLine(r.text), Kind: "rescue", Exempt: true}}
	res, err := h.CheckAndMark(req)
	if err != nil {
		return "", err
	}
	for _, receipt := range res.Receipts {
		if receipt.Action == "given" && receipt.BlockID != "" {
			return "[mex " + receipt.BlockID + "]\n" + r.text, nil
		}
	}
	return "", nil
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(s, "\n")
	if len(line) > 200 {
		line = line[:200]
	}
	return line
}

var shellSearchFilter = sync.OnceValue(func() *regexp.Regexp {
	return regexp.MustCompile(`^(-g|--glob|--iglob|-t|--type|--type-add|-T|--type-not|--include|--exclude|--include-dir|--exclude-dir)(=.*)?$|^-[A-Za-z]*[gtT]$`)
})

// shellSearchScope reads a shell search's first path argument (absolute) and
// whether it filters files by glob or type.
func shellSearchScope(command, pattern, cwd string) (scope string, filtered bool) {
	words := shellparse.Words(shellparse.SearchSegment(command))
	seenPattern := false
	for _, w := range words[1:] {
		switch {
		case shellSearchFilter().MatchString(w):
			return "", true
		case strings.HasPrefix(w, "-"):
		case !seenPattern && w == pattern:
			seenPattern = true
		case seenPattern && scope == "":
			scope = shellparse.Resolve(cwd, w)
		}
	}
	return scope, false
}

// withinScope reports whether a checkout-relative file lies inside a search's
// scope: the checkout itself, a folder that contains it, or the file itself.
func withinScope(checkout, scope, rel string) bool {
	if scope == "" {
		return true
	}
	real, err := place.RealPath(scope)
	if err != nil {
		return false
	}
	if filepath.Clean(real) == filepath.Clean(checkout) {
		return true
	}
	scoped, ok := place.RelativeToCheckout(checkout, real)
	return ok && (rel == scoped || strings.HasPrefix(rel, scoped+"/"))
}
