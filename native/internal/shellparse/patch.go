package shellparse

import (
	"strings"
)

const (
	maxPatchBytes = 256 * 1024
	maxPatchFiles = 200
)

type PatchKind string

const (
	PatchUpdate PatchKind = "update"
	PatchAdd    PatchKind = "add"
	PatchDelete PatchKind = "delete"
)

type PatchChunk struct {
	Before []string
	After  []string
}

type PatchFile struct {
	Path   string
	Kind   PatchKind
	MoveTo string
	Chunks []PatchChunk
}

var patchHeader = lazyRegexp(`^\*\*\* (Update|Add|Delete) File: (.+)$`)

// ParsePatch reads an apply_patch body. An incomplete or oversized patch gives
// nil rather than a partial parse. Relative paths resolve against cwd.
func ParsePatch(body, cwd string) []PatchFile {
	if len(body) > maxPatchBytes {
		return nil
	}
	lines := strings.Split(strings.TrimRight(strings.ReplaceAll(body, "\r\n", "\n"), " \t\n"), "\n")
	if len(lines) < 2 || lines[0] != "*** Begin Patch" || lines[len(lines)-1] != "*** End Patch" {
		return nil
	}
	var out []PatchFile
	cur := -1   // index into out
	chunk := -1 // index into out[cur].Chunks
	for _, line := range lines[1 : len(lines)-1] {
		if m := patchHeader().FindStringSubmatch(line); m != nil {
			if len(out) >= maxPatchFiles {
				return nil
			}
			out = append(out, PatchFile{Path: Resolve(cwd, m[2]), Kind: PatchKind(strings.ToLower(m[1]))})
			cur, chunk = len(out)-1, -1
			continue
		}
		if rest, ok := strings.CutPrefix(line, "*** Move to: "); ok {
			if cur >= 0 {
				out[cur].MoveTo = Resolve(cwd, rest)
			}
			continue
		}
		if cur < 0 {
			continue
		}
		f := &out[cur]
		if line == "@@" || strings.HasPrefix(line, "@@ ") {
			f.Chunks = append(f.Chunks, PatchChunk{})
			chunk = len(f.Chunks) - 1
			continue
		}
		if line == "*** End of File" {
			continue
		}
		if chunk < 0 && f.Kind == PatchAdd {
			f.Chunks = append(f.Chunks, PatchChunk{})
			chunk = len(f.Chunks) - 1
		}
		if chunk < 0 {
			return nil
		}
		c := &f.Chunks[chunk]
		switch {
		case strings.HasPrefix(line, " "):
			c.Before = append(c.Before, line[1:])
			c.After = append(c.After, line[1:])
		case strings.HasPrefix(line, "-"):
			c.Before = append(c.Before, line[1:])
		case strings.HasPrefix(line, "+"):
			c.After = append(c.After, line[1:])
		default:
			return nil
		}
	}
	return out
}

// PatchedFiles lists every file a patch touches, move targets included.
func PatchedFiles(patch []PatchFile) []string {
	seen := map[string]bool{}
	var out []string
	add := func(p string) {
		if p != "" && !seen[p] {
			seen[p] = true
			out = append(out, p)
		}
	}
	for _, f := range patch {
		add(f.Path)
		add(f.MoveTo)
	}
	return out
}
