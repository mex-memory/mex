// Package entries reads delivery snapshots. The entry codec mirrors the Node
// entry-file schema; delivery never trusts the evaluator's partial projection.
package entries

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"go.yaml.in/yaml/v3"
)

const MaxEntryBytes = 64 * 1024

var ErrInvalid = errors.New("invalid delivery entry")

func lazy(pattern string) func() *regexp.Regexp {
	return sync.OnceValue(func() *regexp.Regexp { return regexp.MustCompile(pattern) })
}

var generatedRE = lazy(`(?i)\b(generated|auto-generated|do not edit|codegen)\b`)
var idRE = lazy(`^mx_[a-z0-9]{6,64}$`)
var hashRE = lazy(`^sha256:[a-f0-9]{64}$`)
var driveRE = lazy(`^[A-Za-z]:`)
var dateRE = lazy(`^\d{4}-\d{2}-\d{2}$`)
var shaRE = lazy(`^(?:[a-f0-9]{40}|[a-f0-9]{64})$`)
var legacyNodeRE = lazy(`^[A-Za-z_]+:[0-9a-fA-F]{8,}$`)
var legacyFingerprintRE = lazy(`^(?:[mM][hH]:\d+:(?:[0-9a-fA-F]{2})+|mh2:\d+:[A-Za-z0-9_-]+)$`)

type Source struct {
	Type  string `json:"type"`
	Ref   string `json:"ref"`
	Quote string `json:"quote,omitempty"`
}
type Trigger struct {
	Type    string `json:"type"`
	Match   string `json:"match"`
	Pattern string `json:"pattern"`
}
type Check struct {
	Kind   string            `json:"kind"`
	Role   string            `json:"role"`
	Target map[string]any    `json:"target"`
	Saw    map[string]any    `json:"saw"`
	Files  map[string]string `json:"files"`
}

// CommitAnchor is the commit a decision cites. Patch id, subject and files let
// a squash or rebase copy of it match.
type CommitAnchor struct {
	SHA     string   `json:"sha"`
	PatchID string   `json:"patch_id,omitempty"`
	Subject string   `json:"subject,omitempty"`
	Files   []string `json:"files,omitempty"`
	Quote   string   `json:"quote,omitempty"`
}
type Retirement struct {
	Reason string `json:"reason"`
	By     string `json:"by"`
	At     string `json:"at"`
}
type Entry struct {
	ID         string    `json:"id"`
	Kind       string    `json:"kind"`
	Scope      []string  `json:"scope"`
	Source     Source    `json:"source"`
	Evidence   string    `json:"evidence"`
	OneLine    string    `json:"one_line"`
	When       []Trigger `json:"when,omitempty"`
	Checks     []Check   `json:"checks"`
	Companions []string  `json:"companions,omitempty"`
	// Aliases and asks are retrieval aids only: never delivered, never evidence.
	Aliases    []string      `json:"aliases,omitempty"`
	Asks       []string      `json:"asks,omitempty"`
	Commit     *CommitAnchor `json:"commit,omitempty"`
	Supersedes []string      `json:"supersedes,omitempty"`
	Status     string        `json:"status"`
	Retired    *Retirement   `json:"retired,omitempty"`
	Created    string        `json:"created"`
	Text       string        `json:"text"`
}

var Kinds = []string{"recipe", "rule", "decision", "pitfall", "procedure", "fact", "hint"}

func Parse(data []byte) (*Entry, error) {
	if len(data) > MaxEntryBytes || !utf8.Valid(data) {
		return nil, ErrInvalid
	}
	data = bytes.ReplaceAll(data, []byte("\r\n"), []byte("\n"))
	if !bytes.HasPrefix(data, []byte("---\n")) {
		return nil, ErrInvalid
	}
	end := bytes.Index(data[4:], []byte("\n---\n"))
	if end < 0 {
		return nil, ErrInvalid
	}
	end += 4
	var node yaml.Node
	if yaml.Unmarshal(data[4:end], &node) != nil || len(node.Content) != 1 {
		return nil, ErrInvalid
	}
	v, err := plain(node.Content[0], 0)
	if err != nil {
		return nil, err
	}
	envelope, ok := v.(map[string]any)
	if !ok || len(envelope) != 1 {
		return nil, ErrInvalid
	}
	m, ok := envelope["mex"].(map[string]any)
	if !ok || !metadata(m) {
		return nil, ErrInvalid
	}
	text := strings.TrimSpace(string(data[end+5:]))
	if text == "" || length(text) > 8192 || strings.ContainsRune(text, 0) {
		return nil, ErrInvalid
	}
	raw, _ := json.Marshal(m)
	var e Entry
	if json.Unmarshal(raw, &e) != nil {
		return nil, ErrInvalid
	}
	e.Text = text
	return &e, nil
}

// Plain core YAML only. Count/depth bounds protect the parser projection; the
// 64 KiB input limit also bounds the YAML parser's work.
func plain(n *yaml.Node, depth int) (any, error) {
	if depth > 24 || n.Kind == yaml.AliasNode {
		return nil, ErrInvalid
	}
	switch n.Kind {
	case yaml.MappingNode:
		if n.Tag != "!!map" {
			return nil, ErrInvalid
		}
		m := map[string]any{}
		for i := 0; i < len(n.Content); i += 2 {
			k := n.Content[i]
			if k.Kind != yaml.ScalarNode || k.Tag != "!!str" {
				return nil, ErrInvalid
			}
			if _, ok := m[k.Value]; ok {
				return nil, ErrInvalid
			}
			v, err := plain(n.Content[i+1], depth+1)
			if err != nil {
				return nil, err
			}
			m[k.Value] = v
		}
		return m, nil
	case yaml.SequenceNode:
		if n.Tag != "!!seq" {
			return nil, ErrInvalid
		}
		a := make([]any, 0, len(n.Content))
		for _, c := range n.Content {
			v, err := plain(c, depth+1)
			if err != nil {
				return nil, err
			}
			a = append(a, v)
		}
		return a, nil
	case yaml.ScalarNode:
		switch n.Tag {
		case "!!str":
			return n.Value, nil
		case "!!timestamp":
			// The Node core schema keeps implicit dates as strings. Explicit
			// timestamp tags produce Date objects, which its entry schema refuses.
			if n.Style&yaml.TaggedStyle != 0 {
				return nil, ErrInvalid
			}
			return n.Value, nil
		case "!!null":
			return nil, nil
		case "!!bool":
			return n.Value == "true" || n.Value == "True" || n.Value == "TRUE", nil
		case "!!int", "!!float":
			// YAML 1.2 core treats binary/underscored numbers as strings, and
			// leading zeroes as decimal. yaml.v3 also recognizes older forms.
			literal := strings.TrimLeft(n.Value, "+-")
			if strings.ContainsRune(literal, '_') || strings.HasPrefix(literal, "0b") {
				if n.Style&yaml.TaggedStyle != 0 {
					return nil, ErrInvalid
				}
				return n.Value, nil
			}
			if n.Tag == "!!int" && !strings.HasPrefix(literal, "0x") && !strings.HasPrefix(literal, "0o") {
				if number, err := strconv.ParseFloat(n.Value, 64); err == nil && !math.IsInf(number, 0) {
					return number, nil
				}
			}
			var v any
			if n.Decode(&v) != nil {
				return nil, ErrInvalid
			}
			switch x := v.(type) {
			case int:
				return float64(x), nil
			case int64:
				return float64(x), nil
			case uint64:
				return float64(x), nil
			case float64:
				if !math.IsNaN(x) && !math.IsInf(x, 0) {
					return x, nil
				}
			}
		}
	}
	return nil, ErrInvalid
}
func length(s string) int { return len(utf16.Encode([]rune(s))) }

type rule func(any) bool

func str(v any, max int) bool { s, ok := v.(string); return ok && length(s) <= max }
func line(v any) bool {
	s, ok := v.(string)
	if !ok || strings.TrimSpace(s) == "" || length(s) > 2048 {
		return false
	}
	for _, r := range s {
		if r < 32 || r == 127 {
			return false
		}
	}
	return true
}
func choice(choices ...string) rule {
	return func(v any) bool {
		s, ok := v.(string)
		if !ok {
			return false
		}
		for _, c := range choices {
			if s == c {
				return true
			}
		}
		return false
	}
}
func ident(v any) bool { s, ok := v.(string); return ok && idRE().MatchString(s) }
func hash(v any) bool  { s, ok := v.(string); return ok && hashRE().MatchString(s) }
func relative(v any) bool {
	s, ok := v.(string)
	if !ok || s == "" || length(s) > 512 || strings.HasPrefix(s, "/") || driveRE().MatchString(s) {
		return false
	}
	for _, r := range s {
		if r == '\\' || r < 32 || r == 127 {
			return false
		}
	}
	for _, p := range strings.Split(s, "/") {
		if p == "" || p == "." || p == ".." {
			return false
		}
	}
	return true
}
func file(v any) bool {
	s, ok := v.(string)
	return ok && relative(v) && !strings.ContainsAny(s, "*?[]{}")
}
func date(v any) bool {
	s, ok := v.(string)
	if !ok || !dateRE().MatchString(s) {
		return false
	}
	d, e := time.Parse("2006-01-02", s)
	return e == nil && d.Format("2006-01-02") == s
}
func pointer(v any) bool {
	s, ok := v.(string)
	if !ok || length(s) > 2048 {
		return false
	}
	if s != "" && !strings.HasPrefix(s, "/") {
		return false
	}
	for i, r := range s {
		if r < 32 {
			return false
		}
		if r == '~' && (i+1 >= len(s) || (s[i+1] != '0' && s[i+1] != '1')) {
			return false
		}
	}
	return true
}
func object(v any, required, optional map[string]rule) bool {
	m, ok := v.(map[string]any)
	if !ok {
		return false
	}
	for k, f := range required {
		x, present := m[k]
		if !present || !f(x) {
			return false
		}
	}
	for k, v := range m {
		if _, ok := required[k]; ok {
			continue
		}
		f, ok := optional[k]
		if !ok || !f(v) {
			return false
		}
	}
	return true
}
func list(v any, min, max int, f rule) bool {
	a, ok := v.([]any)
	if !ok || len(a) < min || len(a) > max {
		return false
	}
	for _, x := range a {
		if !f(x) {
			return false
		}
	}
	return true
}
func count(v any) bool {
	n, ok := v.(float64)
	return ok && n >= 0 && n <= 9007199254740991 && math.Trunc(n) == n
}
func bounded(v any) bool {
	remaining := 1024
	var visit func(any, int) bool
	visit = func(v any, d int) bool {
		remaining--
		if remaining < 0 || d > 12 {
			return false
		}
		switch x := v.(type) {
		case nil, bool:
			return true
		case float64:
			return !math.IsNaN(x) && !math.IsInf(x, 0)
		case string:
			return length(x) <= 8192
		case []any:
			if len(x) > 1024 {
				return false
			}
			for _, y := range x {
				if !visit(y, d+1) {
					return false
				}
			}
			return true
		case map[string]any:
			for k, y := range x {
				if length(k) > 512 || !visit(y, d+1) {
					return false
				}
			}
			return true
		}
		return false
	}
	if !visit(v, 0) {
		return false
	}
	return jsonSize(v) <= 8192
}

// JSON.stringify does not HTML-escape strings and uses decimal notation
// between 1e-6 and 1e21. Count those bytes rather than Go's escaped JSON size.
func jsonSize(v any) int {
	switch x := v.(type) {
	case nil:
		return 4
	case bool:
		if x {
			return 4
		}
		return 5
	case string:
		n := 2
		for _, r := range x {
			switch r {
			case '"', '\\', '\b', '\f', '\n', '\r', '\t':
				n += 2
			default:
				if r < 32 {
					n += 6
				} else {
					n += utf8.RuneLen(r)
				}
			}
		}
		return n
	case float64:
		if x == 0 {
			return 1
		}
		a := math.Abs(x)
		if a >= 1e-6 && a < 1e21 {
			return len(strconv.FormatFloat(x, 'f', -1, 64))
		}
		s := strconv.FormatFloat(x, 'e', -1, 64)
		s = strings.Replace(s, "e-0", "e-", 1)
		s = strings.Replace(s, "e+0", "e+", 1)
		return len(s)
	case []any:
		n := 2
		for i, y := range x {
			if i > 0 {
				n++
			}
			n += jsonSize(y)
		}
		return n
	case map[string]any:
		n := 2
		i := 0
		for k, y := range x {
			if i > 0 {
				n++
			}
			n += jsonSize(k) + 1 + jsonSize(y)
			i++
		}
		return n
	}
	return 8193
}
func metadata(v any) bool {
	required := map[string]rule{
		"id": ident, "kind": choice(Kinds...), "scope": func(v any) bool { return list(v, 1, 32, relative) },
		"source": func(v any) bool {
			return object(v, map[string]rule{"type": choice("person", "docs", "review", "ci", "config", "rule-file", "mined", "observed", "agent-memory"), "ref": line}, map[string]rule{"quote": func(v any) bool { s, ok := v.(string); return ok && length(s) >= 1 && length(s) <= 8192 }})
		},
		"evidence": choice("person", "docs", "review", "ci", "mined", "observed"), "one_line": func(v any) bool { return line(v) && str(v, 1024) },
		"checks": func(v any) bool { return list(v, 0, 32, validCheck) }, "status": choice("active", "proposed", "retired"), "created": date,
	}
	optional := map[string]rule{
		"when": func(v any) bool {
			return list(v, 0, 32, func(v any) bool {
				return object(v, map[string]rule{"type": choice("anti", "required", "rejected", "creates"), "match": choice("literal", "structural"), "pattern": line}, nil)
			})
		},
		"companions": func(v any) bool { return list(v, 0, 32, ident) },
		"aliases":    func(v any) bool { return phrases(v, 8, 40) },
		"asks":       func(v any) bool { return phrases(v, 5, 120) },
		"supersedes": func(v any) bool { return list(v, 0, 8, ident) },
		"commit": func(v any) bool {
			sha := func(v any) bool { s, ok := v.(string); return ok && shaRE().MatchString(s) }
			return object(v, map[string]rule{"sha": sha}, map[string]rule{"patch_id": sha, "subject": func(v any) bool { return trimmedLine(v, 512) }, "quote": func(v any) bool { return trimmedLine(v, 512) }, "files": func(v any) bool { return list(v, 0, 64, file) }})
		},
		"retired": func(v any) bool { return object(v, map[string]rule{"reason": line, "by": line, "at": date}, nil) },
	}
	if !object(v, required, optional) {
		return false
	}
	m := v.(map[string]any)
	source := m["source"].(map[string]any)
	if source["type"] == "person" {
		if _, ok := source["quote"]; !ok {
			return false
		}
	}
	_, retired := m["retired"]
	return retired == (m["status"] == "retired")
}
func trimmedLine(v any, max int) bool {
	s, ok := v.(string)
	return ok && line(v) && length(s) <= max && strings.TrimSpace(s) == s
}

// phrases is a bounded list of trimmed one-line phrases, unique ignoring case.
func phrases(v any, max, chars int) bool {
	if !list(v, 0, max, func(v any) bool { return trimmedLine(v, chars) }) {
		return false
	}
	seen := map[string]bool{}
	for _, p := range v.([]any) {
		k := strings.ToLower(p.(string))
		if seen[k] {
			return false
		}
		seen[k] = true
	}
	return true
}
func validCheck(v any) bool {
	m, ok := v.(map[string]any)
	if !ok {
		return false
	}
	var target, saw map[string]rule
	var optional map[string]rule
	switch m["kind"] {
	case "legacy-grounding":
		return object(v, map[string]rule{
			"kind": choice("legacy-grounding"), "role": choice("supporting"),
			"target": func(v any) bool {
				return object(v, map[string]rule{"node": func(v any) bool { return line(v) && legacyNodeRE().MatchString(v.(string)) }}, map[string]rule{"file": file})
			},
			"saw": func(v any) bool {
				return object(v, map[string]rule{"fingerprint": func(v any) bool { return line(v) && legacyFingerprintRE().MatchString(v.(string)) }}, map[string]rule{"bodyHash": line, "codeHash": line})
			},
			"files": func(v any) bool { m, ok := v.(map[string]any); return ok && len(m) == 0 },
		}, nil)
	case "key":
		target = map[string]rule{"file": file, "pointer": pointer}
		optional = map[string]rule{"member": func(v any) bool {
			s, ok := v.(string)
			return ok && length(s) > 0 && length(s) <= 512 && strings.TrimSpace(s) == s && !strings.ContainsRune(s, '\uFEFF') && strings.IndexFunc(s, unicode.IsControl) < 0
		}}
		saw = map[string]rule{"value": bounded}
		if t, ok := m["target"].(map[string]any); ok {
			if _, member := t["member"]; member {
				saw = map[string]rule{"value": func(v any) bool { return v == true }}
			}
		}
	case "command":
		target = map[string]rule{"run": line, "file": file, "pointer": pointer}
		saw = map[string]rule{"exists": func(v any) bool { _, ok := v.(bool); return ok }}
	case "section":
		target = map[string]rule{"file": file, "heading": line}
		saw = map[string]rule{"hash": hash}
	case "source":
		if t, ok := m["target"].(map[string]any); ok && t["url"] != nil {
			target = map[string]rule{"url": func(v any) bool {
				s, ok := v.(string)
				if !ok || length(s) > 2048 {
					return false
				}
				u, e := url.Parse(s)
				return e == nil && u.Host != "" && (u.Scheme == "http" || u.Scheme == "https")
			}}
		} else {
			target = map[string]rule{"file": file}
		}
		saw = map[string]rule{"hash": hash}
	case "value":
		target = map[string]rule{"file": file, "symbol": line}
		saw = map[string]rule{"value": bounded}
	case "symbol":
		target = map[string]rule{"file": file, "symbol": line}
		saw = map[string]rule{"fingerprint": line}
	case "pattern":
		target = map[string]rule{"scope": relative, "pattern": line}
		optional = map[string]rule{"match": choice("literal", "structural")}
		saw = map[string]rule{"count": count}
	case "relation":
		target = map[string]rule{"query": line, "from": relative, "to": relative}
		saw = map[string]rule{"count": count}
	default:
		return false
	}
	return object(v, map[string]rule{"kind": func(any) bool { return true }, "role": choice("complete", "supporting"), "target": func(v any) bool { return object(v, target, optional) }, "saw": func(v any) bool { return object(v, saw, nil) }, "files": func(v any) bool {
		m, ok := v.(map[string]any)
		if !ok || len(m) > 128 {
			return false
		}
		for k, v := range m {
			if !file(k) || !hash(v) {
				return false
			}
		}
		return true
	}}, nil)
}

// String is useful in bounded diagnostics without including entry contents.
func (e Entry) String() string {
	return fmt.Sprintf("%s (%s, %s)", e.ID, e.Kind, strconv.Quote(e.Status))
}
