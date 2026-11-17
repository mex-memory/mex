package graph

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path"
	"sort"
	"strings"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/internal/contract"
)

// Card limits (sheet 49). Starting values; the plan calls them parameters.
const (
	maxCardChars   = 600
	maxSpanLines   = 300
	maxCallers     = 3
	maxUsedByShown = 5
)

// Card is one graph item for delivery. It competes with knowledge for the
// same epoch budget: Tokens is what it costs, Value the tokens of the reads,
// search output or turns it replaces.
type Card struct {
	Kind   string `json:"kind"` // search, signature or tests
	Key    string `json:"key"`  // the same card for the same code
	Text   string `json:"text"`
	Tokens int    `json:"tokens"`
	Value  int    `json:"value"`
	AsOf   string `json:"as_of"`
}

// Seen holds the keys of cards already sent this epoch. A key includes the
// code's hash, so a card comes back only when the code changed.
type Seen map[string]bool

// Allowed reports a moment cards may go out at. Nothing is sent at session
// start: the graph only helps pick knowledge there.
func Allowed(kind contract.Kind) bool { return kind != contract.SessionStart }

func key(parts ...string) string {
	h := sha256.Sum256([]byte(strings.Join(parts, "\x00")))
	return parts[0] + ":" + hex.EncodeToString(h[:8])
}

func finish(c *Card, seen Seen) (*Card, bool) {
	if seen[c.Key] || len(c.Text) > maxCardChars {
		return nil, false
	}
	c.Tokens = entries.EstimateTokens(c.Text)
	return c, true
}

// unique resolves a name to the one definition it names, with its span from
// the file index. Names that resolve to several places, or to a span too
// long to be useful, get no card.
func unique(r Reader, files Files, name string) (Symbol, bool) {
	defs, err := r.Resolve(name)
	if err != nil || len(defs) != 1 {
		return Symbol{}, false
	}
	def, ok := Exact(files, defs[0])
	if !ok || def.End-def.Start+1 > maxSpanLines {
		return Symbol{}, false
	}
	return def, true
}

func at(path string, line int) string { return fmt.Sprintf("%s:%d", path, line) }

func head(s Symbol) string {
	if s.Signature != "" {
		return "`" + s.Signature + "`"
	}
	return "`" + s.Name + "`"
}

// tokensOf sums the read cost of distinct files: what the agent would read
// without the card.
func tokensOf(files Files, paths ...string) int {
	total, done := 0, map[string]bool{}
	for _, p := range paths {
		if done[p] {
			continue
		}
		done[p] = true
		if info, miss := files.FileInfo(p); miss == nil {
			total += info.Tokens
		}
	}
	return total
}

// calls keeps real calls, one per enclosing symbol, in path and line order.
func calls(sites []Site) []Site {
	var out []Site
	seen := map[string]bool{}
	for _, s := range sites {
		if s.Kind != Call || seen[s.In.ID] {
			continue
		}
		seen[s.In.ID] = true
		out = append(out, s)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Path != out[j].Path {
			return out[i].Path < out[j].Path
		}
		return out[i].Line < out[j].Line
	})
	return out
}

// SearchCard goes beside a search for a name: the definition with its
// signature, up to 3 callers and 1 direct test, instead of the follow-up
// reads.
func SearchCard(r Reader, files Files, name string, seen Seen) (*Card, bool) {
	def, ok := unique(r, files, name)
	if !ok {
		return nil, false
	}
	sites, err := r.Callers(def.ID)
	if err != nil {
		return nil, false
	}
	sites, dropped := Recheck(sites, r, files)
	callers := calls(sites)
	tests, err := r.Tests(def.ID)
	if err != nil {
		return nil, false
	}
	var direct, viaCaller *TestLink
	for i := range tests {
		t := &tests[i]
		test, ok := Exact(files, t.Test)
		if !ok {
			continue
		}
		t.Test = test
		if t.Reach == Direct && direct == nil {
			direct = t
		} else if t.Reach == ViaCaller && viaCaller == nil {
			viaCaller = t
		}
	}
	testLine := "tests: none"
	read := []string{def.Path}
	switch {
	case direct != nil:
		testLine = "test: " + at(direct.Test.Path, direct.Test.Start) + " (" + direct.Test.Name + ")"
		read = append(read, direct.Test.Path)
	case viaCaller != nil:
		testLine = "tested only through a caller: " + at(viaCaller.Test.Path, viaCaller.Test.Start)
	}
	unresolved := ""
	if n := r.Unresolved(def.ID); n > 0 {
		unresolved = fmt.Sprintf("\n+%d dynamic calls not resolved", n)
	}
	// Up to 3 callers; fewer when the card would pass 600 characters.
	for shown := min(len(callers), maxCallers); shown >= 0; shown-- {
		callerLine, callerFiles := callerSummary(callers, shown, r.Complete() && dropped == 0)
		text := head(def) + " · " + at(def.Path, def.Start) + "\n" + callerLine + "\n" + testLine + unresolved
		if len(text) <= maxCardChars {
			paths := append(append([]string{}, read...), callerFiles...)
			return finish(&Card{Kind: "search", Key: key("search", def.ID, def.Hash), Text: text, Value: tokensOf(files, paths...), AsOf: r.AsOf()}, seen)
		}
	}
	return nil, false
}

// callerSummary is the callers line with the first shown callers, and the
// files those callers are in. "No callers" needs a complete graph and no
// caller dropped as stale.
func callerSummary(callers []Site, shown int, complete bool) (string, []string) {
	switch {
	case len(callers) == 0 && complete:
		return "no callers", nil
	case len(callers) == 0:
		return "callers unknown", nil
	case shown == 0:
		return fmt.Sprintf("called by %d callers", len(callers)), nil
	}
	parts := make([]string, 0, shown)
	paths := make([]string, 0, shown)
	for _, s := range callers[:shown] {
		parts = append(parts, fmt.Sprintf("%s (%s)", at(s.Path, s.Line), s.In.Name))
		paths = append(paths, s.Path)
	}
	more := ""
	if len(callers) > shown {
		more = fmt.Sprintf(" +%d more", len(callers)-shown)
	}
	return "called by " + strings.Join(parts, ", ") + more, paths
}

// SignatureCard goes out once on an edit that changes an exported
// signature: the files that use it, instead of a broken-callers round trip.
// Values passed elsewhere count: they break on a new signature too.
func SignatureCard(r Reader, files Files, def Symbol, before string, seen Seen) (*Card, bool) {
	if !def.Exported || def.Signature == "" || def.Signature == before {
		return nil, false
	}
	sites, err := r.Callers(def.ID)
	if err != nil {
		return nil, false
	}
	sites, _ = Recheck(sites, r, files)
	byFile := map[string]Site{}
	for _, s := range sites {
		if s.Path == def.Path {
			continue
		}
		if prior, ok := byFile[s.Path]; !ok || s.Line < prior.Line {
			byFile[s.Path] = s
		}
	}
	if len(byFile) == 0 {
		return nil, false
	}
	paths := make([]string, 0, len(byFile))
	for p := range byFile {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	noun := "files"
	if len(paths) == 1 {
		noun = "file"
	}
	for shown := min(len(paths), maxUsedByShown); shown > 0; shown-- {
		parts := make([]string, 0, shown)
		for _, p := range paths[:shown] {
			parts = append(parts, at(p, byFile[p].Line))
		}
		more := ""
		if shown < len(paths) {
			more = " …"
		}
		text := fmt.Sprintf("%s changed · used by %d %s: %s%s", head(def), len(paths), noun, strings.Join(parts, ", "), more)
		if len(text) <= maxCardChars {
			return finish(&Card{Kind: "signature", Key: key("signature", def.ID, def.Signature), Text: text, Value: tokensOf(files, paths[:shown]...), AsOf: r.AsOf()}, seen)
		}
	}
	return nil, false
}

// TestsCard goes out before a full test run after edits: the tests that
// cover what changed, and a scoped command when the runner is known.
// fullRun is the tokens a full run's output usually costs here.
func TestsCard(r Reader, files Files, changed []Symbol, command string, fullRun int, seen Seen) (*Card, bool) {
	reach := map[string]Reach{}
	var hashes []string
	for _, def := range changed {
		hashes = append(hashes, def.ID+"@"+def.Hash)
		tests, err := r.Tests(def.ID)
		if err != nil {
			return nil, false
		}
		for _, t := range tests {
			if _, ok := Exact(files, t.Test); !ok {
				continue
			}
			if reach[t.Test.Path] != Direct {
				reach[t.Test.Path] = t.Reach
			}
		}
	}
	if len(reach) == 0 {
		return nil, false
	}
	var direct, via []string
	for p, how := range reach {
		if how == Direct {
			direct = append(direct, p)
		} else {
			via = append(via, p)
		}
	}
	sort.Strings(direct)
	sort.Strings(via)
	var parts []string
	if len(direct) > 0 {
		parts = append(parts, strings.Join(direct, ", ")+" (direct)")
	}
	if len(via) > 0 {
		parts = append(parts, strings.Join(via, ", ")+" (through a tested caller)")
	}
	text := "Tests covering your changes: " + strings.Join(parts, "; ")
	if scoped, ok := ScopedCommand(command, append(append([]string{}, direct...), via...)); ok {
		text += "\nScoped: `" + scoped + "`"
	}
	sort.Strings(hashes)
	return finish(&Card{Kind: "tests", Key: key(append([]string{"tests"}, hashes...)...), Text: text, Value: fullRun, AsOf: r.AsOf()}, seen)
}

// ScopedCommand narrows a full test command to the given test files, for
// runners that take files as arguments. Anything else, including commands
// that already name files or chain other commands, is left alone.
func ScopedCommand(command string, testFiles []string) (string, bool) {
	if len(testFiles) == 0 || strings.ContainsAny(command, "|;&<>`$\n") {
		return "", false
	}
	runner := false
	for _, f := range strings.Fields(command) {
		if !runner {
			switch path.Base(f) {
			case "vitest", "jest", "mocha", "pytest":
				runner = true
			}
			continue
		}
		if !strings.HasPrefix(f, "-") && strings.ContainsAny(f, "/.") {
			return "", false // already names files
		}
	}
	if !runner {
		return "", false
	}
	return command + " " + strings.Join(testFiles, " "), true
}
