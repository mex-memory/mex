package delivery

// The nearest similar file at file creation (layer D): an agent that creates
// a file follows the shape of what it last read, not the area's. Right after
// a new file is created, MEX names the closest existing file of the same kind
// from the file index, so the agent can match its structure, imports and
// naming. It needs no knowledge entry. It is a guess, so it starts in trial,
// and it is silent on any doubt: no index, no file of the same kind, or more
// than one equally close.

import (
	"path"
	"sort"
	"strings"

	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record"
)

const siblingSurface = "create-sibling"

// siblingRescue returns the pointer for a file this event created, or nil.
func siblingRescue(ev contract.Event, env Environment, tool contract.Tool) *rescue {
	if tool.Output == nil || !tool.Output.OK {
		return nil
	}
	var created []string
	switch tool.Name {
	case contract.ToolWrite:
		if tool.Input.Path != "" && writeCreated(tool) {
			created = append(created, tool.Input.Path)
		}
	case contract.ToolPatch:
		for _, f := range tool.Input.Files {
			if f.Kind == "add" {
				created = append(created, f.Path)
			}
		}
	}
	if len(created) != 1 || !rescueAllowed(env, ev.ProjectID, siblingSurface) {
		return nil // several new files at once is scaffolding, not one file to shape
	}
	rel, ok := relTo(ev.Checkout, slash(created[0]))
	if !ok || rel == "" || nonCode[path.Ext(rel)] {
		return nil
	}
	idx := openRescueIndex(env, ev)
	if idx == nil {
		return nil
	}
	defer closeRescueIndex(env, idx)
	dir, base := path.Dir(rel), path.Base(rel)
	kind := compoundExt(base)
	if kind == "" {
		return nil
	}
	in := func(glob string) []string {
		found, _, err := idx.PathsMatching(glob, 200)
		if err != nil {
			return nil
		}
		var out []string
		for _, p := range found {
			if p != rel && isTest(p) == isTest(rel) && compoundExt(path.Base(p)) == kind && onDisk(ev.Checkout, p) {
				out = append(out, p)
			}
		}
		return out
	}
	prefix := func(p string) string {
		if dir == "." {
			return p
		}
		return dir + "/" + p
	}
	// The same folder first, closest name; then the same name one folder over
	// (handlers/orders/index.ts beside handlers/users/index.ts).
	best := closestName(in(prefix("*"+kind)), base)
	if best == "" && dir != "." {
		parent := path.Dir(dir)
		glob := "*/" + base
		if parent != "." {
			glob = parent + "/" + glob
		}
		if found := in(glob); len(found) > 0 {
			sort.Strings(found)
			best = found[0]
		}
	}
	if best == "" {
		return nil
	}
	return &rescue{surface: siblingSurface, project: ev.ProjectID, checkout: ev.Checkout,
		text:   "New file " + rel + ". The nearest existing file of the same kind is " + best + ": match its structure, imports and naming.",
		target: record.SurfaceTarget{Paths: []string{best}}}
}

// compoundExt is everything from a name's first dot: ".controller.ts",
// ".test.go", ".tsx". "" for a name without one, or a dotfile.
func compoundExt(name string) string {
	i := strings.IndexByte(name, '.')
	if i <= 0 {
		return ""
	}
	return name[i:]
}

func isTest(p string) bool {
	base := path.Base(p)
	return strings.Contains(base, ".test.") || strings.Contains(base, ".spec.") || strings.Contains(base, "_test.") ||
		strings.HasPrefix(base, "test_") || strings.Contains("/"+p, "/__tests__/")
}

// closestName picks the candidate sharing the longest name prefix with the
// new file, or the only one; "" when there is none or two tie.
func closestName(candidates []string, base string) string {
	best, bestLen, tie := "", -1, false
	for _, c := range candidates {
		n := commonPrefix(path.Base(c), base)
		switch {
		case n > bestLen:
			best, bestLen, tie = c, n, false
		case n == bestLen:
			tie = true
		}
	}
	if tie {
		return "" // two equally close: a guess either way
	}
	return best
}

func commonPrefix(a, b string) int {
	n := 0
	for n < len(a) && n < len(b) && a[n] == b[n] {
		n++
	}
	return n
}
