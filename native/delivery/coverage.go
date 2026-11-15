package delivery

import (
	"bytes"
	"encoding/json"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/brief"
	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/record/place"
	"go.yaml.in/yaml/v3"
)

// Native coverage: an entry the agent already loads for this path through
// its own rule files is not sent again (sheet 29, "Delivery skips an entry
// the agent already loads for that path").
//
// Two cases, both decided from files, with no hook event needed:
//   - entries read from a rule file (source type rule-file): covered when that
//     file is one this agent loads for the path;
//   - entries `mex share` wrote into a rule file: covered when a loaded rule
//     file carries the entry's id marker `<!-- mex:<id> -->`.

const maxRuleFileBytes = 256 * 1024

// nativeFiles lists the rule files the agent loads for a path, relative to the
// checkout, nearest folder last. Claude Code loads CLAUDE.md files on the way
// to the files it touches, and every .claude/rules file (path-scoped ones are
// treated as loaded; a miss here only means one extra short delivery).
// AGENTS.md counts for Claude Code only where that folder has no CLAUDE.md.
// Codex loads AGENTS.md (or AGENTS.override.md) from the root to its working
// folder.
func nativeFiles(agent, checkout, rel string, exists func(string) bool) []string {
	dirs := []string{""}
	folder := path.Dir(rel)
	if rel == "" || folder == "." {
		folder = ""
	}
	if folder != "" {
		parts := strings.Split(folder, "/")
		for i := range parts {
			dirs = append(dirs, strings.Join(parts[:i+1], "/"))
		}
	}
	join := func(d, f string) string {
		if d == "" {
			return f
		}
		return d + "/" + f
	}
	var out []string
	for _, d := range dirs {
		switch agent {
		case "claude-code":
			claude := false
			for _, f := range []string{"CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"} {
				if exists(join(d, f)) {
					out = append(out, join(d, f))
					claude = true
				}
			}
			if !claude && exists(join(d, "AGENTS.md")) {
				out = append(out, join(d, "AGENTS.md"))
			}
		case "codex":
			if exists(join(d, "AGENTS.override.md")) {
				out = append(out, join(d, "AGENTS.override.md"))
			} else if exists(join(d, "AGENTS.md")) {
				out = append(out, join(d, "AGENTS.md"))
			}
		}
	}
	return out
}

type coverage struct {
	files      map[string]bool // rule files loaded, relative to the checkout
	ids        map[string]bool // entry ids marked inside them
	native     brief.Coverage
	agent, rel string
	texts      []string // loaded rule-file text, for the similarity check
}

var markerRE = lazy(`<!--\s*mex:(mx_[a-z0-9]{6,64})\s*-->`)

func loadCoverage(agent, checkout, rel string, context ...brief.Options) coverage {
	opts := brief.Options{Checkout: checkout, Agent: agent}
	if len(context) > 0 {
		opts = context[0]
	}
	c := coverage{files: map[string]bool{}, ids: map[string]bool{}, native: brief.ReadGeneratedCoverage(opts), agent: agent, rel: rel}
	exists := func(r string) bool {
		_, err := readBounded(filepath.Join(checkout, filepath.FromSlash(r)), maxRuleFileBytes)
		return err == nil
	}
	nativeRel := rel
	if agent == "codex" && opts.NativeCwd != "" {
		if cwd, err := place.RealPath(opts.NativeCwd); err == nil {
			if r, ok := relTo(checkout, cwd); ok {
				nativeRel = path.Join(r, "__mex_current__")
			}
		}
	}
	files := nativeFiles(agent, checkout, nativeRel, exists)
	if agent == "claude-code" {
		if matches, _ := filepath.Glob(filepath.Join(checkout, ".claude", "rules", "*.md")); len(matches) > 0 {
			for i, m := range matches {
				if i >= 64 {
					break
				}
				if r, ok := relTo(slash(checkout), slash(m)); ok {
					files = append(files, r)
				}
			}
		}
	}
	nativeBytes, textBytes := 0, 0
	for _, f := range files {
		data, err := readBounded(filepath.Join(checkout, filepath.FromSlash(f)), maxRuleFileBytes)
		if err != nil {
			continue
		}
		if agent == "codex" {
			nativeBytes += len(data)
			if nativeBytes > 32<<10 {
				break
			}
		}
		if strings.HasPrefix(f, ".claude/rules/") && bytes.HasPrefix(data, []byte("---\n")) {
			header, _, ok := strings.Cut(string(data[4:]), "\n---\n")
			var meta struct {
				Paths []string `yaml:"paths"`
			}
			if !ok || yaml.Unmarshal([]byte(header), &meta) != nil || len(meta.Paths) > 32 {
				continue
			}
			matches := len(meta.Paths) == 0
			for _, scope := range meta.Paths {
				matches = matches || index.MatchesScope(scope, rel)
			}
			if !matches {
				continue
			}
		}
		c.files[f] = true
		if textBytes += len(data); textBytes <= 1<<20 {
			c.texts = append(c.texts, string(data))
		}
		// Generated text is authenticated by its manifest and exact file hash.
		if bytes.Contains(data, []byte("<!-- mex:generated")) {
			continue
		}
		for _, m := range markerRE().FindAllSubmatch(data, 512) {
			c.ids[string(m[1])] = true
		}
	}
	return c
}

func (c coverage) covers(it *entries.Item) bool {
	if c.native.Covers(it.Entry.ID, c.agent, c.rel) {
		return true
	}
	if c.ids[it.Entry.ID] {
		return true
	}
	if it.Entry.Source.Type == "rule-file" {
		ref := it.Entry.Source.Ref
		if i := strings.IndexAny(ref, "#:"); i > 0 {
			ref = ref[:i]
		}
		return c.files[slash(strings.TrimPrefix(ref, "./"))]
	}
	return false
}

// Hints observed in an agent's own memory are loaded by that agent already,
// and their eligibility (expiry, forgotten claims, source still present) is
// decided by the Node side. The hook delivers a hint only when the Node
// side's small mirror lists it for this agent and it has not expired:
// <record dir>/delivery-hints/<short hash of project id>.json
// {"version":1,"agents":{"codex":[{"id":"mx_...","expires":"RFC3339"}]}}.
// No mirror means no hints: the safe answer.
type hintMirror struct {
	Version int                    `json:"version"`
	Agents  map[string][]hintEntry `json:"agents"`
}
type hintEntry struct {
	ID      string `json:"id"`
	Expires string `json:"expires"`
}

func HintMirrorPath(recordDirectory, project string) string {
	return filepath.Join(recordDirectory, "delivery-hints", place.ShortHash(project)+".json")
}

func hintGate(recordDirectory, project, agent string, now time.Time) func(*entries.Item) bool {
	var allowed map[string]bool
	loaded := false
	return func(it *entries.Item) bool {
		if !loaded {
			loaded = true
			allowed = map[string]bool{}
			data, err := readBounded(HintMirrorPath(recordDirectory, project), 1<<20)
			var m hintMirror
			if err == nil && json.Unmarshal(data, &m) == nil && m.Version == 1 {
				for _, h := range m.Agents[agent] {
					if t, err := time.Parse(time.RFC3339, h.Expires); err == nil && now.Before(t) {
						allowed[h.ID] = true
					}
				}
			}
		}
		return allowed[it.Entry.ID]
	}
}
