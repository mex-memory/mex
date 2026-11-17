package brief

import (
	"encoding/json"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/mex-memory/mex/native/check"
	"github.com/mex-memory/mex/native/delivery/entries"
	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/record/place"
	"go.yaml.in/yaml/v3"
)

// CoverageFile records exact, currently present native text, not a plan to write it.
type CoverageFile struct {
	Path   string   `json:"path"`
	Agents []string `json:"agents"`
	Scope  []string `json:"scope"`
	IDs    []string `json:"ids"`
	Hash   string   `json:"hash"`
}

type Coverage struct {
	Files []CoverageFile `json:"files"`
}

func contains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

// Covers is the delivery gate shared by the brief and the later moment controller.
// path is checkout-relative; an empty path denotes the checkout's root area.
func (c Coverage) Covers(id, agent, file string) bool {
	for _, f := range c.Files {
		if !contains(f.IDs, id) || !contains(f.Agents, agent) {
			continue
		}
		for _, scope := range f.Scope {
			if index.MatchesScope(scope, file) {
				return true
			}
		}
	}
	return false
}

type ruleCache struct {
	Version int    `json:"version"`
	Root    string `json:"root"`
	Files   []struct {
		Path, Format, Hash string
		Agents, Scope      []string
	} `json:"files"`
	Entries []struct {
		Path  string `json:"path"`
		Entry struct {
			Mex  entries.Entry `json:"mex"`
			Text string        `json:"text"`
		} `json:"entry"`
	} `json:"entries"`
	Review []struct {
		Paths []string `json:"paths"`
	} `json:"review"`
}

func readRules(root, home *os.Root, opts Options) ruleCache {
	var cache ruleCache
	data, err := readFile(home, "projects/"+opts.ProjectID+"/rule-files.json", maxScanBytes)
	if err != nil || json.Unmarshal(data, &cache) != nil || cache.Version != 1 || len(cache.Files) > maxFiles || len(cache.Entries) > check.MaxEntries {
		return ruleCache{}
	}
	// A worktree has a different rule-file snapshot, even when notes are shared.
	cacheRoot, rootErr := place.RealPath(cache.Root)
	if rootErr != nil || filepath.Clean(cacheRoot) != filepath.Clean(opts.Checkout) {
		return ruleCache{}
	}
	valid := map[string]bool{}
	bytes := 0
	for _, f := range cache.Files {
		body, err := readFile(root, f.Path, maxRuleBytes)
		bytes += len(body)
		if bytes > maxScanBytes {
			return ruleCache{}
		}
		if err == nil && hash(body) == f.Hash {
			valid[f.Path] = true
		}
	}
	files := cache.Files[:0]
	for _, f := range cache.Files {
		if valid[f.Path] {
			files = append(files, f)
		}
	}
	cache.Files = files
	entries := cache.Entries[:0]
	for _, e := range cache.Entries {
		if valid[e.Path] {
			entries = append(entries, e)
		}
	}
	cache.Entries = entries
	return cache
}

var entryComment = regexp.MustCompile(`<!-- (?:mex:)?(mx_[a-z0-9]{6,64}) -->`)

// ReadCoverage is read-only. A missing/changed/hand-edited generated file never
// suppresses delivery. Rule scans are accepted only for this exact checkout and
// while each original rule file still has the scanned hash.
func ReadCoverage(opts Options) Coverage {
	return readCoverageOptions(opts, true)
}

// ReadGeneratedCoverage avoids the imported-rule scan on the moment hot path.
func ReadGeneratedCoverage(opts Options) Coverage {
	return readCoverageOptions(opts, false)
}

func readCoverageOptions(opts Options, includeRules bool) Coverage {
	canonical, err := place.RealPath(opts.Checkout)
	if err != nil {
		return Coverage{}
	}
	opts.Checkout = canonical
	root, err := os.OpenRoot(opts.Checkout)
	if err != nil {
		return Coverage{}
	}
	defer root.Close()
	home, _ := os.OpenRoot(opts.MexHome)
	if home != nil {
		defer home.Close()
	}
	cache := ruleCache{}
	if includeRules {
		cache = readRules(root, home, opts)
	}
	return readCoverage(root, home, opts, cache)
}

func readCoverage(root, home *os.Root, opts Options, cache ruleCache) Coverage {
	c := Coverage{Files: []CoverageFile{}}
	for _, f := range cache.Files {
		ids := []string{}
		for _, e := range cache.Entries {
			if e.Path == f.Path {
				ids = append(ids, e.Entry.Mex.ID)
			}
		}
		agents := nativeAgents(root, f.Path, f.Agents)
		c.Files = append(c.Files, CoverageFile{f.Path, agents, f.Scope, ids, f.Hash})
	}
	for _, source := range []struct {
		root *os.Root
		file string
	}{{root, ".mex/native.json"}, {home, "projects/" + opts.ProjectID + "/native-local.json"}} {
		var manifest struct {
			Version int               `json:"version"`
			Files   map[string]string `json:"files"`
		}
		data, err := readFile(source.root, source.file, 128<<10)
		if err != nil || json.Unmarshal(data, &manifest) != nil || manifest.Version != 1 || len(manifest.Files) > maxFiles {
			continue
		}
		for name, want := range manifest.Files {
			body, err := readFile(root, name, 8<<10)
			if err != nil || hash(body) != want || !strings.Contains(string(body), "<!-- mex:generated") {
				continue
			}
			f := CoverageFile{Path: name, Hash: want}
			switch {
			case path.Base(name) == "AGENTS.md":
				f.Agents = nativeAgents(root, name, []string{"codex", "claude-code"})
				area := path.Dir(name)
				f.Scope = []string{"**"}
				if area != "." {
					f.Scope = []string{area + "/**"}
				}
			case strings.HasPrefix(name, ".claude/rules/") && strings.HasSuffix(name, ".md"):
				f.Agents, f.Scope = []string{"claude-code"}, []string{"**"}
				if strings.HasPrefix(string(body), "---\n") {
					head, _, ok := strings.Cut(string(body[4:]), "\n---\n")
					var front struct {
						Paths []string `yaml:"paths"`
					}
					if !ok || yaml.Unmarshal([]byte(head), &front) != nil || len(front.Paths) == 0 || len(front.Paths) > 32 {
						continue
					}
					f.Scope = front.Paths
				}
			default:
				continue
			}
			for _, match := range entryComment.FindAllSubmatch(body, -1) {
				f.IDs = append(f.IDs, string(match[1]))
			}
			c.Files = append(c.Files, f)
		}
	}
	sort.Slice(c.Files, func(i, j int) bool { return c.Files[i].Path < c.Files[j].Path })
	addObserved(&c, root, opts)
	if opts.NativeCwd != "" {
		cwd, err := place.RealPath(opts.NativeCwd)
		rel, inside := place.RelativeToCheckout(opts.Checkout, cwd)
		if cwd == opts.Checkout {
			rel, inside = "", true
		}
		for i := range c.Files {
			folder := path.Dir(c.Files[i].Path)
			if err != nil || !inside || (folder != "." && rel != folder && !strings.HasPrefix(rel, folder+"/")) {
				agents := []string{}
				for _, agent := range c.Files[i].Agents {
					if agent != "codex" {
						agents = append(agents, agent)
					}
				}
				c.Files[i].Agents = agents
			}
		}
	}
	return c
}

// Recheck sibling precedence now, rather than relying on a previous scan.
func nativeAgents(root *os.Root, name string, agents []string) []string {
	result := []string{}
	for _, agent := range agents {
		base, folder := path.Base(name), path.Dir(name)
		if agent == "claude-code" && (base == "AGENTS.md" || base == "AGENTS.override.md") {
			if base == "AGENTS.override.md" {
				continue
			}
			if _, err := root.Lstat(path.Join(folder, "CLAUDE.md")); err == nil {
				continue
			}
			if _, err := root.Lstat(path.Join(folder, "CLAUDE.local.md")); err == nil {
				continue
			}
		}
		if agent == "codex" && base == "AGENTS.md" {
			if info, err := root.Lstat(path.Join(folder, "AGENTS.override.md")); err == nil && info.Size() > 0 {
				continue
			}
		}
		if agent == "codex" && !codexWithinBudget(root, name) {
			continue
		}
		result = append(result, agent)
	}
	return result
}

// Codex's default project-document budget is cumulative along the ancestor
// chain. A partly loaded file cannot authorize suppressing a whole entry.
func codexWithinBudget(root *os.Root, name string) bool {
	folder := path.Dir(name)
	dirs := []string{"."}
	if folder != "." {
		parts := strings.Split(folder, "/")
		for i := range parts {
			dirs = append(dirs, strings.Join(parts[:i+1], "/"))
		}
	}
	remaining := 32 << 10
	for _, dir := range dirs {
		selected := path.Join(dir, "AGENTS.md")
		if info, err := root.Lstat(path.Join(dir, "AGENTS.override.md")); err == nil && info.Size() > 0 {
			selected = path.Join(dir, "AGENTS.override.md")
		}
		if _, err := root.Lstat(selected); os.IsNotExist(err) {
			continue
		}
		data, err := readFile(root, selected, 32<<10)
		if err != nil || len(data) > remaining {
			return false
		}
		remaining -= len(data)
		if selected == name {
			return true
		}
	}
	return false
}
