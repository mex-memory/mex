// Package check evaluates the small checks each knowledge entry carries and
// turns them into a verdict: held, changed, broken or unknown.
//
// It reads entry files (docs/design/knowledge-entry.md) and the repository
// files their checks name. It never runs a command, never calls a model and
// never touches the network.
package check

import (
	"bytes"
	"errors"
	"fmt"

	"go.yaml.in/yaml/v3"
)

// MaxEntryBytes matches the Node codec's file limit.
const MaxEntryBytes = 64 * 1024

// Entry is the part of an entry file the evaluator needs.
type Entry struct {
	ID     string   `yaml:"id"`
	Kind   string   `yaml:"kind"`
	Scope  []string `yaml:"scope"`
	Checks []Check  `yaml:"checks"`
	Status string   `yaml:"status"`
}

// Check is one stored check: {kind, role, target, saw, files}.
type Check struct {
	Kind   string            `yaml:"kind" json:"kind"`
	Role   string            `yaml:"role" json:"role"`
	Target map[string]any    `yaml:"target" json:"target"`
	Saw    map[string]any    `yaml:"saw" json:"saw"`
	Files  map[string]string `yaml:"files" json:"files"`
}

var (
	idPattern   = lazy(`^mx_[a-z0-9]{6,64}$`)
	hashPattern = lazy(`^sha256:[a-f0-9]{64}$`)
	frontmatter = lazy(`(?s)\A---\n(.*?)\n---\n`)
)

// ErrInvalidEntry is wrapped by every parse failure.
var ErrInvalidEntry = errors.New("invalid entry")

// ParseEntry reads the mex block of one entry file. It refuses what the Node
// codec refuses that would change meaning here: aliases, custom tags,
// duplicate keys, a bad id, an unknown role and malformed file hashes.
func ParseEntry(data []byte) (*Entry, error) {
	if len(data) > MaxEntryBytes {
		return nil, fmt.Errorf("%w: larger than %d bytes", ErrInvalidEntry, MaxEntryBytes)
	}
	data = bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n"))
	m := frontmatter().FindSubmatch(data)
	if m == nil {
		return nil, fmt.Errorf("%w: no frontmatter", ErrInvalidEntry)
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(m[1], &doc); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidEntry, err)
	}
	if err := plainYAML(&doc); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidEntry, err)
	}
	var envelope struct {
		Mex *Entry `yaml:"mex"`
	}
	if err := doc.Decode(&envelope); err != nil || envelope.Mex == nil {
		return nil, fmt.Errorf("%w: no mex block", ErrInvalidEntry)
	}
	e := envelope.Mex
	if !idPattern().MatchString(e.ID) {
		return nil, fmt.Errorf("%w: bad id", ErrInvalidEntry)
	}
	if e.Status != "active" && e.Status != "retired" {
		return nil, fmt.Errorf("%w: bad status", ErrInvalidEntry)
	}
	if len(e.Checks) > 32 {
		return nil, fmt.Errorf("%w: too many checks", ErrInvalidEntry)
	}
	for i := range e.Checks {
		c := &e.Checks[i]
		if c.Role != Complete && c.Role != Supporting {
			return nil, fmt.Errorf("%w: check %d has role %q", ErrInvalidEntry, i, c.Role)
		}
		if c.Target == nil || c.Saw == nil {
			return nil, fmt.Errorf("%w: check %d lacks target or saw", ErrInvalidEntry, i)
		}
		if len(c.Files) > 128 {
			return nil, fmt.Errorf("%w: check %d reads too many files", ErrInvalidEntry, i)
		}
		for path, hash := range c.Files {
			if !safeRelative(path) || !hashPattern().MatchString(hash) {
				return nil, fmt.Errorf("%w: check %d has a bad file hash", ErrInvalidEntry, i)
			}
		}
	}
	return e, nil
}

// plainYAML refuses anchors, aliases, merge keys and non-core tags.
func plainYAML(n *yaml.Node) error {
	if n.Kind == yaml.AliasNode || n.Anchor != "" {
		return errors.New("aliases are not allowed")
	}
	switch n.Tag {
	case "", "!!map", "!!seq", "!!str", "!!int", "!!float", "!!bool", "!!null", "!!timestamp":
	default:
		return fmt.Errorf("tag %s is not allowed", n.Tag)
	}
	for _, child := range n.Content {
		if err := plainYAML(child); err != nil {
			return err
		}
	}
	return nil
}
