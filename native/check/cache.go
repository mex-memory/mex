package check

import (
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"time"

	"github.com/mex-memory/mex/native/record/place"
)

// The hook runs the free stage after every edit, and reading and parsing
// every entry file each time costs about 0.3 ms per entry on Windows (47 ms
// for 132 entries). The entry cache remembers each parsed entry file by its
// size and modification time, so a run re-reads only entry files that
// changed. It is a local cache next to hooks.db: never in git, safe to
// delete, and rebuilt from the entry files whenever it is missing or stale.

const entryCacheVersion = 2

// racyWindow: a file modified this close to the cache's own write may change
// again without its size or time changing, so it is never trusted.
const racyWindow = 2 * time.Second

type cachedEntry struct {
	Size  int64  `json:"size"`
	MTime int64  `json:"mtime"`
	Hash  string `json:"hash"`
	Entry *Entry `json:"entry,omitempty"`
	Err   string `json:"err,omitempty"`
}

type entryCacheFile struct {
	Version int                    `json:"version"`
	Written int64                  `json:"written"`
	Files   map[string]cachedEntry `json:"files"`
}

// entryCache is one checkout's cache. A nil *entryCache reads every file.
type entryCache struct {
	path    string
	written int64
	old     map[string]cachedEntry
	now     map[string]cachedEntry
	dirty   bool
}

// EntryCachePath is where a checkout's entry cache lives in the record
// directory.
func EntryCachePath(recordDirectory, checkout string) string {
	return filepath.Join(recordDirectory, "check-entries", place.ShortHash(checkout)+".json")
}

func openEntryCache(path string) *entryCache {
	c := &entryCache{path: path, old: map[string]cachedEntry{}, now: map[string]cachedEntry{}}
	data, err := os.ReadFile(path)
	if err != nil {
		c.dirty = true
		return c
	}
	var f entryCacheFile
	if json.Unmarshal(data, &f) != nil || f.Version != entryCacheVersion || f.Files == nil {
		c.dirty = true
		return c
	}
	c.written, c.old = f.Written, f.Files
	return c
}

// read returns the entry file at path, from the cache when its size and
// time are unchanged and it wasn't modified just before the cache was written.
func (c *entryCache) read(path, level string, info fs.FileInfo) Loaded {
	if c == nil || info == nil {
		return readEntry(path, level)
	}
	size, mtime := info.Size(), info.ModTime().UnixNano()
	if hit, ok := c.old[path]; ok && hit.Size == size && hit.MTime == mtime && mtime < c.written-int64(racyWindow) {
		c.now[path] = hit
		l := Loaded{Level: level, Path: path, Hash: hit.Hash, Entry: hit.Entry}
		if hit.Err != "" {
			l.Entry, l.Err = nil, errors.New(hit.Err)
		}
		return l
	}
	l := readEntry(path, level)
	entry := cachedEntry{Size: size, MTime: mtime, Hash: l.Hash, Entry: l.Entry}
	if l.Entry != nil && l.Entry.Source.Quote != "" {
		projected := *l.Entry
		projected.Source.Quote = ""
		entry.Entry = &projected
	}
	if l.Err != nil {
		entry.Err = l.Err.Error()
	}
	// A file that couldn't be read at all isn't cached.
	if l.Hash != "" {
		c.now[path] = entry
	}
	c.dirty = true
	return l
}

// save writes the cache when anything changed. Errors are ignored: the
// cache only saves time.
func (c *entryCache) save(now time.Time) {
	if c == nil {
		return
	}
	if !c.dirty && len(c.now) == len(c.old) {
		return
	}
	data, err := json.Marshal(entryCacheFile{Version: entryCacheVersion, Written: now.UnixNano(), Files: c.now})
	if err != nil {
		return
	}
	dir := filepath.Dir(c.path)
	if os.MkdirAll(dir, 0o700) != nil {
		return
	}
	tmp, err := os.CreateTemp(dir, ".entries-*")
	if err != nil {
		return
	}
	_, werr := tmp.Write(data)
	cerr := tmp.Close()
	if werr != nil || cerr != nil || os.Rename(tmp.Name(), c.path) != nil {
		_ = os.Remove(tmp.Name())
	}
}
