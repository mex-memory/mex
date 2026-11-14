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
		// A count covers a whole scope; it records no single file.
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
