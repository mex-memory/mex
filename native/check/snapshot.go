package check

import "errors"

// NewSnapshotEvaluator checks bounded Git blobs in memory. Omitted inputs are
// unreadable, not missing, and there is no filesystem or index fallback.
func NewSnapshotEvaluator(source map[string]*string) (*Evaluator, error) {
	if len(source) > 16 {
		return nil, errors.New("too many snapshot files")
	}
	f := &files{cache: map[string]fileRead{}}
	for path, text := range source {
		if !safeRelative(path) || (text != nil && len(*text) > 64<<10) {
			return nil, errors.New("invalid snapshot file")
		}
		r := fileRead{err: errMissing}
		if text != nil {
			r = fileRead{data: []byte(*text), hash: hashBytes([]byte(*text))}
		}
		f.cache[path] = r
	}
	return &Evaluator{files: f}, nil
}

// SnapshotInputsHash uses the same fingerprint recorded with live verdicts.
// Index-backed checks cannot establish a snapshot pass without an index.
func (ev *Evaluator) SnapshotInputsHash(entry *Entry, content []byte) string {
	return ev.inputsHash(Loaded{Entry: entry, Hash: hashBytes(content)}, "")
}
