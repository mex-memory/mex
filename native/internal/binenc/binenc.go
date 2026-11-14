// Package binenc is a small length-prefixed binary encoding for the hook's
// own cache files. It has no package init work, unlike encoding/gob, whose
// type registry costs about half a millisecond at every hook start.
package binenc

import (
	"encoding/binary"
	"errors"
	"sort"
)

var ErrShort = errors.New("binenc: truncated or invalid data")

type Writer struct{ b []byte }

func (w *Writer) Bytes() []byte { return w.b }

func (w *Writer) Uint(v uint64) { w.b = binary.AppendUvarint(w.b, v) }
func (w *Writer) Int(v int64)   { w.b = binary.AppendVarint(w.b, v) }
func (w *Writer) Bool(v bool) {
	if v {
		w.b = append(w.b, 1)
	} else {
		w.b = append(w.b, 0)
	}
}
func (w *Writer) String(s string) {
	w.Uint(uint64(len(s)))
	w.b = append(w.b, s...)
}
func (w *Writer) Strings(list []string) {
	w.Uint(uint64(len(list)))
	for _, s := range list {
		w.String(s)
	}
}

// Set writes the keys of a set in sorted order.
func (w *Writer) Set(m map[string]bool) {
	keys := make([]string, 0, len(m))
	for k, v := range m {
		if v {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	w.Strings(keys)
}

type Reader struct {
	b   []byte
	err error
}

func NewReader(b []byte) *Reader { return &Reader{b: b} }

// Err is the first error; every read after it returns zero values.
func (r *Reader) Err() error { return r.err }

func (r *Reader) Uint() uint64 {
	if r.err != nil {
		return 0
	}
	v, n := binary.Uvarint(r.b)
	if n <= 0 {
		r.err = ErrShort
		return 0
	}
	r.b = r.b[n:]
	return v
}

func (r *Reader) Int() int64 {
	if r.err != nil {
		return 0
	}
	v, n := binary.Varint(r.b)
	if n <= 0 {
		r.err = ErrShort
		return 0
	}
	r.b = r.b[n:]
	return v
}

func (r *Reader) Bool() bool {
	if r.err != nil || len(r.b) == 0 {
		r.err = ErrShort
		return false
	}
	v := r.b[0]
	r.b = r.b[1:]
	if v > 1 {
		r.err = ErrShort
	}
	return v == 1
}

func (r *Reader) String() string {
	n := r.Uint()
	if r.err != nil || n > uint64(len(r.b)) {
		r.err = ErrShort
		return ""
	}
	s := string(r.b[:n])
	r.b = r.b[n:]
	return s
}

// Count reads a list length and refuses one longer than max.
func (r *Reader) Count(max int) int {
	n := r.Uint()
	if r.err == nil && n > uint64(max) {
		r.err = ErrShort
	}
	if r.err != nil {
		return 0
	}
	return int(n)
}

func (r *Reader) Strings(max int) []string {
	n := r.Count(max)
	if n == 0 {
		return nil
	}
	out := make([]string, 0, n)
	for i := 0; i < n && r.err == nil; i++ {
		out = append(out, r.String())
	}
	return out
}

func (r *Reader) Set(max int) map[string]bool {
	out := map[string]bool{}
	for _, k := range r.Strings(max) {
		out[k] = true
	}
	return out
}

// Done reports an error unless every byte was read.
func (r *Reader) Done() error {
	if r.err == nil && len(r.b) != 0 {
		r.err = ErrShort
	}
	return r.err
}
