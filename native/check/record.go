package check

import (
	"errors"
	"fmt"
)

// ErrNotRecordable is returned when a check can't be written against today's
// code: its target is missing, unreadable or of a kind not built yet.
var ErrNotRecordable = errors.New("check can't be recorded")

// Record writes a check against today's code: it reads the target, fills in
// saw and the hashes of the files read, and confirms the result passes. A
// writer (setup, capture, the judge) calls this, so every stored check
// passed when it was written.
func (ev *Evaluator) Record(kind, role string, target map[string]any) (Check, error) {
	if role != Complete && role != Supporting {
		return Check{}, fmt.Errorf("%w: role %q", ErrNotRecordable, role)
	}
	c := Check{Kind: kind, Role: role, Target: target, Saw: map[string]any{}, Files: map[string]string{}}
	var file string
	switch kind {
	case "key":
		file = str(target, "file")
		data, _, ok := ev.readTarget(file)
		if !ok {
			return Check{}, fmt.Errorf("%w: %s can't be read", ErrNotRecordable, file)
		}
		doc, err := parseConfig(file, data)
		if err != nil {
			return Check{}, fmt.Errorf("%w: %s can't be parsed", ErrNotRecordable, file)
		}
		value, found := resolvePointer(doc, str(target, "pointer"))
		if !found {
			return Check{}, fmt.Errorf("%w: %s has no %s", ErrNotRecordable, file, str(target, "pointer"))
		}
		if raw, member := target["member"]; member {
			name, valid := memberName(raw)
			if !valid {
				return Check{}, fmt.Errorf("%w: invalid member name", ErrNotRecordable)
			}
			present, err := dependencyMember(value, name)
			if err != nil || !present {
				return Check{}, fmt.Errorf("%w: declared dependency is absent or unsupported", ErrNotRecordable)
			}
			value = true
		}
		c.Saw["value"] = value
	case "command":
		file = str(target, "file")
		c.Saw["exists"] = true
	case "section":
		file = str(target, "file")
		data, _, ok := ev.readTarget(file)
		if !ok {
			return Check{}, fmt.Errorf("%w: %s can't be read", ErrNotRecordable, file)
		}
		body, found := section(data, str(target, "heading"))
		if !found {
			return Check{}, fmt.Errorf("%w: %s has no section %q", ErrNotRecordable, file, str(target, "heading"))
		}
		c.Saw["hash"] = textHash(body)
	case "source":
		file = str(target, "file")
		if file == "" {
			return Check{}, fmt.Errorf("%w: URL sources are recorded by the network pass", ErrNotRecordable)
		}
		data, _, ok := ev.readTarget(file)
		if !ok {
			return Check{}, fmt.Errorf("%w: %s can't be read", ErrNotRecordable, file)
		}
		c.Saw["hash"] = textHash(string(data))
	case "value":
		file = str(target, "file")
		now, res, ok := ev.readValue(file, str(target, "symbol"))
		if !ok {
			return Check{}, fmt.Errorf("%w: %s", ErrNotRecordable, res.Reason)
		}
		c.Saw["value"] = now
	case "symbol":
		file = str(target, "file")
		if ev.index == nil {
			return Check{}, fmt.Errorf("%w: symbol checks need the file index", ErrNotRecordable)
		}
		fp, res, ok := ev.fingerprint(file, str(target, "symbol"))
		if !ok {
			return Check{}, fmt.Errorf("%w: %s", ErrNotRecordable, res.Reason)
		}
		c.Saw["fingerprint"] = fp
	case "pattern":
		count, res, ok := ev.patternCount(target)
		if !ok {
			return Check{}, fmt.Errorf("%w: %s", ErrNotRecordable, res.Reason)
		}
		c.Saw["count"] = count
		// Exact scopes retain their observed file, so changed-but-held checks
		// can be rechecked and the judge receives the full source and diff.
		// Glob scopes still record no unbounded set of individual files.
		if file := exactPatternFile(target); file != "" {
			c.Files[file] = ev.files.read(file).hash
		}
		if got := ev.run(c); got.Status != Pass {
			return Check{}, fmt.Errorf("%w: %s", ErrNotRecordable, got.Reason)
		}
		return c, nil
	case "relation":
		count, res, ok := ev.relationCount(target, nil)
		if !ok {
			return Check{}, fmt.Errorf("%w: %s", ErrNotRecordable, res.Reason)
		}
		c.Saw["count"] = count.n
		// Like a pattern, a relation covers a scope, not a single file.
		if got := ev.run(c); got.Status != Pass {
			return Check{}, fmt.Errorf("%w: %s", ErrNotRecordable, got.Reason)
		}
		return c, nil
	default:
		return Check{}, fmt.Errorf("%w: %s checks are not built yet", ErrNotRecordable, kind)
	}
	r := ev.files.read(file)
	if r.err != nil {
		return Check{}, fmt.Errorf("%w: %s can't be read", ErrNotRecordable, file)
	}
	c.Files[file] = r.hash
	if got := ev.run(c); got.Status != Pass {
		return Check{}, fmt.Errorf("%w: %s", ErrNotRecordable, got.Reason)
	}
	return c, nil
}
