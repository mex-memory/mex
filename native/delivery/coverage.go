package delivery

import (
	"encoding/json"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/record/place"
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
	files map[string]bool // rule files loaded, relative to the checkout
	ids   map[string]bool // entry ids marked inside them
}

var markerRE = lazy(`<!--\s*mex:(mx_[a-z0-9]{6,64})\s*-->`)

func loadCoverage(agent, checkout, rel string) coverage {
	c := coverage{files: map[string]bool{}, ids: map[string]bool{}}
	exists := func(r string) bool {
		_, err := readBounded(filepath.Join(checkout, filepath.FromSlash(r)), maxRuleFileBytes)
		return err == nil
	}
	files := nativeFiles(agent, checkout, rel, exists)
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
	for _, f := range files {
		c.files[f] = true
		data, err := readBounded(filepath.Join(checkout, filepath.FromSlash(f)), maxRuleFileBytes)
		if err != nil {
			continue
		}
		for _, m := range markerRE().FindAllSubmatch(data, 512) {
			c.ids[string(m[1])] = true
		}
	}
	return c
}

func (c coverage) covers(it *entries.Item) bool {
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
