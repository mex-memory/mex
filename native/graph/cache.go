package graph

import "github.com/mex-memory/mex/native/index"

// Cached answers each file's reads once for one request: a card or an answer
// asks about the same few files many times.
func Cached(f Files) Files {
	if f == nil {
		return nil
	}
	if _, ok := f.(*cachedFiles); ok {
		return f
	}
	return &cachedFiles{inner: f, info: map[string]infoAnswer{}, outline: map[string]outlineAnswer{}, edited: map[string]bool{}, test: map[string][2]bool{}}
}

type infoAnswer struct {
	a *index.FileInfoAnswer
	m *index.Miss
}

type outlineAnswer struct {
	a *index.OutlineAnswer
	m *index.Miss
}

type cachedFiles struct {
	inner   Files
	info    map[string]infoAnswer
	outline map[string]outlineAnswer
	edited  map[string]bool
	test    map[string][2]bool
}

func (c *cachedFiles) FileInfo(path string) (*index.FileInfoAnswer, *index.Miss) {
	if v, ok := c.info[path]; ok {
		return v.a, v.m
	}
	a, m := c.inner.FileInfo(path)
	c.info[path] = infoAnswer{a, m}
	return a, m
}

func (c *cachedFiles) Outline(path string) (*index.OutlineAnswer, *index.Miss) {
	if v, ok := c.outline[path]; ok {
		return v.a, v.m
	}
	a, m := c.inner.Outline(path)
	c.outline[path] = outlineAnswer{a, m}
	return a, m
}

func (c *cachedFiles) Edited(path string) bool {
	e, ok := c.inner.(editAware)
	if !ok {
		return false
	}
	if v, ok := c.edited[path]; ok {
		return v
	}
	v := e.Edited(path)
	c.edited[path] = v
	return v
}

func (c *cachedFiles) TestFlag(path string) (bool, bool) {
	t, ok := c.inner.(interface{ TestFlag(string) (bool, bool) })
	if !ok {
		return false, false
	}
	if v, ok := c.test[path]; ok {
		return v[0], v[1]
	}
	is, known := t.TestFlag(path)
	c.test[path] = [2]bool{is, known}
	return is, known
}

func (c *cachedFiles) CodeFiles(disk bool) (map[string]string, error) {
	l, ok := c.inner.(Listing)
	if !ok {
		return nil, errNoListing
	}
	return l.CodeFiles(disk)
}

// Listing reports whether the files can be listed, so "none" can be said.
func canList(f Files) bool {
	if c, ok := f.(*cachedFiles); ok {
		f = c.inner
	}
	_, ok := f.(Listing)
	return ok
}
