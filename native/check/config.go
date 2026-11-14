package check

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"strconv"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"
)

var errUnsupported = errors.New("unsupported file type")

// parseConfig reads a JSON (comments and trailing commas allowed) or YAML
// file into plain JSON-shaped values. Other formats are unsupported.
func parseConfig(name string, data []byte) (any, error) {
	switch strings.ToLower(path.Ext(name)) {
	case ".json", ".jsonc":
		var v any
		if err := json.Unmarshal(data, &v); err == nil {
			return v, nil
		}
		if err := json.Unmarshal(stripJSONC(data), &v); err != nil {
			return nil, err
		}
		return v, nil
	case ".yaml", ".yml":
		var v any
		if err := yaml.Unmarshal(data, &v); err != nil {
			return nil, err
		}
		return normalize(v)
	}
	return nil, errUnsupported
}

// stripJSONC removes comments and trailing commas outside strings.
func stripJSONC(data []byte) []byte {
	out := make([]byte, 0, len(data))
	inString, escaped := false, false
	for i := 0; i < len(data); i++ {
		c := data[i]
		if inString {
			out = append(out, c)
			switch {
			case escaped:
				escaped = false
			case c == '\\':
				escaped = true
			case c == '"':
				inString = false
			}
			continue
		}
		switch {
		case c == '"':
			inString = true
			out = append(out, c)
		case c == '/' && i+1 < len(data) && data[i+1] == '/':
			for i < len(data) && data[i] != '\n' {
				i++
			}
			out = append(out, '\n')
		case c == '/' && i+1 < len(data) && data[i+1] == '*':
			i += 2
			for i+1 < len(data) && !(data[i] == '*' && data[i+1] == '/') {
				i++
			}
			i++
		case c == ',':
			j := i + 1
			for j < len(data) && (data[j] == ' ' || data[j] == '\t' || data[j] == '\r' || data[j] == '\n') {
				j++
			}
			if j < len(data) && (data[j] == '}' || data[j] == ']') {
				continue
			}
			out = append(out, c)
		default:
			out = append(out, c)
		}
	}
	return out
}

// normalize turns decoded YAML or entry values into the shapes encoding/json
// produces: map[string]any, []any, float64, string, bool and nil.
func normalize(v any) (any, error) {
	switch t := v.(type) {
	case nil, string, bool, float64:
		return t, nil
	case int:
		return float64(t), nil
	case int64:
		return float64(t), nil
	case uint64:
		return float64(t), nil
	case float32:
		return float64(t), nil
	case time.Time:
		// YAML reads an unquoted date as a time; the Node codec keeps the text.
		if t.Equal(t.Truncate(24*time.Hour)) && t.Location() == time.UTC {
			return t.Format("2006-01-02"), nil
		}
		return t.Format(time.RFC3339Nano), nil
	case []any:
		out := make([]any, len(t))
		for i, item := range t {
			n, err := normalize(item)
			if err != nil {
				return nil, err
			}
			out[i] = n
		}
		return out, nil
	case map[string]any:
		out := make(map[string]any, len(t))
		for k, item := range t {
			n, err := normalize(item)
			if err != nil {
				return nil, err
			}
			out[k] = n
		}
		return out, nil
	case map[any]any:
		out := make(map[string]any, len(t))
		for k, item := range t {
			n, err := normalize(item)
			if err != nil {
				return nil, err
			}
			out[fmt.Sprint(k)] = n
		}
		return out, nil
	}
	return nil, fmt.Errorf("value of type %T", v)
}

// equalValues compares two JSON-shaped values after normalizing both.
func equalValues(a, b any) bool {
	na, err1 := normalize(a)
	nb, err2 := normalize(b)
	if err1 != nil || err2 != nil {
		return false
	}
	ja, err1 := json.Marshal(na)
	jb, err2 := json.Marshal(nb)
	return err1 == nil && err2 == nil && bytes.Equal(ja, jb)
}

// resolvePointer follows an RFC 6901 JSON Pointer. found is false when a
// step doesn't exist.
func resolvePointer(doc any, pointer string) (value any, found bool) {
	if pointer == "" {
		return doc, true
	}
	if !strings.HasPrefix(pointer, "/") {
		return nil, false
	}
	current := doc
	for _, raw := range strings.Split(pointer[1:], "/") {
		token := strings.ReplaceAll(strings.ReplaceAll(raw, "~1", "/"), "~0", "~")
		switch node := current.(type) {
		case map[string]any:
			next, ok := node[token]
			if !ok {
				return nil, false
			}
			current = next
		case []any:
			i, err := strconv.Atoi(token)
			if err != nil || i < 0 || i >= len(node) || (len(token) > 1 && token[0] == '0') {
				return nil, false
			}
			current = node[i]
		default:
			return nil, false
		}
	}
	return current, true
}

var makeTarget = lazy(`^([A-Za-z0-9_.%/-]+(?:\s+[A-Za-z0-9_.%/-]+)*)\s*::?(?:[^=]|$)`)

// makeTargets lists the rule names a Makefile defines.
func makeTargets(data []byte) map[string]bool {
	targets := map[string]bool{}
	for _, line := range strings.Split(strings.ReplaceAll(string(data), "\r\n", "\n"), "\n") {
		if strings.HasPrefix(line, "\t") || strings.HasPrefix(line, "#") {
			continue
		}
		if m := makeTarget().FindStringSubmatch(line); m != nil {
			for _, name := range strings.Fields(m[1]) {
				targets[name] = true
			}
		}
	}
	return targets
}

func isMakefile(name string) bool {
	base := strings.ToLower(path.Base(name))
	return base == "makefile" || base == "gnumakefile" || strings.HasSuffix(base, ".mk")
}
