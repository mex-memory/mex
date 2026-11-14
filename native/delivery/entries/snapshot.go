package entries

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/record/place"
)

const maxScanBytes = 8 * 1024 * 1024
const maxChildren = 10000
const cacheVersion = 1

type Item struct {
	Entry                     *Entry `json:"entry"`
	Level                     string `json:"level"`
	Path                      string `json:"path"`
	Hash                      string `json:"hash"`
	Full, OneLine             string
	FullTokens, OneLineTokens int
	Scopes                    []*regexp.Regexp `json:"-"`
	// Hint eligibility depends on source identity, consumer and observation
	// state, not just a valid file. The later gate must explicitly clear it.
	NeedsHintGate bool
}
type Snapshot struct {
	Items          []Item
	Retired        []string
	Parsed, Reused int
}
type fileCache struct {
	Size  int64
	MTime int64
	Hash  string
	Entry *Entry
}
type cacheFile struct {
	Version int
	Written int64
	Files   map[string]fileCache
}

// CachePath is checkout-specific even for worktrees sharing a project id.
func CachePath(directory, project, checkout string) string {
	return filepath.Join(directory, "delivery-entries", place.ShortHash(project+"\n"+checkout)+".json")
}

// Load validates source metadata on every call. Directory metadata alone
// cannot detect an in-place edit. The cache avoids YAML work for unchanged
// entries, never authorizes delivery or replaces store/verdict gates.
func Load(directory, home, project, checkout string) (Snapshot, error) {
	var result Snapshot
	if directory == "" || checkout == "" || !validComponent(project) {
		return result, ErrInvalid
	}
	path := CachePath(directory, project, checkout)
	old := cacheFile{}
	if b, err := readRegular(path, 32*1024*1024); err == nil {
		if json.Unmarshal(b, &old) != nil {
			old = cacheFile{}
		}
	}
	if old.Version != cacheVersion {
		old = cacheFile{}
	}
	next := cacheFile{Version: cacheVersion, Written: time.Now().UnixNano(), Files: map[string]fileCache{}}
	type store struct {
		base   string
		parts  []string
		level  string
		nested bool
	}
	stores := []store{{checkout, []string{".mex", "learned"}, "team", true}}
	if home != "" {
		stores = append(stores, store{home, []string{"projects", project, "notes"}, "personal", false}, store{home, []string{"projects", project, "hints"}, "hint", false})
	}
	total, seen := 0, 0
	globs := map[string]*regexp.Regexp{}
	dirty := old.Files == nil
	for _, s := range stores {
		root, err := contained(s.base, s.parts)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return Snapshot{}, err
		}
		// Recheck below the resolved root after scanning too, so a directory
		// retarget during this load cannot publish a redirected snapshot.
		originalRoot := root
		ids := map[string]bool{}
		var walk func(string, bool) error
		walk = func(folder string, nested bool) error {
			dir, err := os.Open(folder)
			if err != nil {
				return err
			}
			defer dir.Close()
			openedFolder, err := dir.Stat()
			if err != nil {
				return err
			}
			for {
				children, readErr := dir.ReadDir(128)
				for _, child := range children {
					seen++
					if seen > maxChildren {
						return errors.New("entry directory scan bound exceeded")
					}
					full := filepath.Join(folder, child.Name())
					info, err := child.Info()
					if err != nil {
						return err
					}
					if info.Mode()&os.ModeSymlink != 0 {
						return errors.New("redirected entry store")
					}
					if info.IsDir() {
						if nested && isKind(child.Name()) {
							if err := walk(full, false); err != nil {
								return err
							}
						}
						continue
					}
					if !strings.HasSuffix(child.Name(), ".md") || !idRE().MatchString(strings.TrimSuffix(child.Name(), ".md")) {
						continue
					}
					if !info.Mode().IsRegular() {
						return errors.New("entry is not a regular file")
					}
					id := strings.TrimSuffix(child.Name(), ".md")
					if ids[id] {
						return errors.New("duplicate entry id")
					}
					ids[id] = true
					if info.Size() > MaxEntryBytes {
						return ErrInvalid
					}
					total += int(info.Size())
					if total > maxScanBytes {
						return errors.New("entry byte scan bound exceeded")
					}
					hit, ok := old.Files[full]
					if ok && hit.Size == info.Size() && hit.MTime == info.ModTime().UnixNano() && hit.MTime < old.Written-int64(2*time.Second) {
						result.Reused++
					} else {
						data, err := readRegular(full, MaxEntryBytes)
						if err != nil {
							return err
						}
						h := sha256.Sum256(data)
						entry, _ := Parse(data)
						hit = fileCache{info.Size(), info.ModTime().UnixNano(), "sha256:" + hex.EncodeToString(h[:]), entry}
						result.Parsed++
						dirty = true
					}
					next.Files[full] = hit
					if hit.Entry == nil || hit.Entry.ID != id {
						continue
					}
					if hit.Entry.Status == "retired" {
						result.Retired = append(result.Retired, id)
						continue
					}
					if hit.Entry.Status != "active" {
						continue
					}
					item := Item{Entry: hit.Entry, Level: s.level, Path: full, Hash: hit.Hash, NeedsHintGate: s.level == "hint"}
					label := label(hit.Entry, s.level)
					item.Full = label + " " + hit.Entry.Text
					item.OneLine = label + " " + hit.Entry.OneLine
					item.FullTokens = EstimateTokens(item.Full)
					item.OneLineTokens = EstimateTokens(item.OneLine)
					for _, scope := range hit.Entry.Scope {
						re := globs[scope]
						if re == nil {
							var err error
							re, err = index.CompileGlob(scope)
							if err != nil {
								return err
							}
							globs[scope] = re
						}
						item.Scopes = append(item.Scopes, re)
					}
					result.Items = append(result.Items, item)
				}
				if errors.Is(readErr, io.EOF) {
					break
				}
				if readErr != nil {
					return readErr
				}
			}
			currentFolder, err := os.Lstat(folder)
			if err != nil || !currentFolder.IsDir() || currentFolder.Mode()&os.ModeSymlink != 0 || !os.SameFile(openedFolder, currentFolder) {
				return errors.New("entry directory changed during scan")
			}
			return nil
		}
		if err = walk(root, s.nested); err != nil {
			return Snapshot{}, err
		}
		root, err = contained(s.base, s.parts)
		if err != nil || !samePath(root, originalRoot) {
			return Snapshot{}, errors.New("entry directory changed during scan")
		}
	}
	if len(old.Files) != len(next.Files) {
		dirty = true
	}
	if dirty {
		saveCache(path, next)
	}
	return result, nil
}
func isKind(s string) bool {
	for _, k := range Kinds {
		if s == k {
			return true
		}
	}
	return false
}
func validComponent(s string) bool {
	if s == "" || s == "." || s == ".." {
		return false
	}
	for _, r := range s {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune("._-", r)) {
			return false
		}
	}
	return true
}
func contained(base string, parts []string) (string, error) {
	resolved, err := place.RealPath(base)
	if err != nil {
		return "", err
	}
	current := resolved
	for _, p := range parts {
		if !validComponent(p) {
			return "", ErrInvalid
		}
		current = filepath.Join(current, p)
		st, err := os.Lstat(current)
		if err != nil {
			return "", err
		}
		if !st.IsDir() || st.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("redirected entry directory")
		}
		real, err := place.RealPath(current)
		if err != nil || !samePath(real, current) {
			return "", errors.New("redirected entry directory")
		}
	}
	return current, nil
}
func samePath(a, b string) bool {
	return filepath.Clean(a) == filepath.Clean(b) || runtime.GOOS == "windows" && strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
}
func readRegular(path string, max int) ([]byte, error) {
	before, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() || before.Size() > int64(max) {
		return nil, ErrInvalid
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil || !os.SameFile(before, opened) {
		return nil, ErrInvalid
	}
	data, err := io.ReadAll(io.LimitReader(f, int64(max)+1))
	if err != nil {
		return nil, err
	}
	after, err := f.Stat()
	leaf, leafErr := os.Lstat(path)
	if err != nil || leafErr != nil || !os.SameFile(opened, leaf) || !leaf.Mode().IsRegular() || len(data) > max || int64(len(data)) != after.Size() || opened.Size() != after.Size() || !opened.ModTime().Equal(after.ModTime()) {
		return nil, ErrInvalid
	}
	return data, nil
}
func saveCache(path string, c cacheFile) {
	b, err := json.Marshal(c)
	if err != nil {
		return
	}
	dir := filepath.Dir(path)
	if os.MkdirAll(dir, 0700) != nil {
		return
	}
	f, err := os.CreateTemp(dir, ".snapshot-*")
	if err != nil {
		return
	}
	_, werr := f.Write(b)
	cerr := f.Close()
	if werr != nil || cerr != nil || os.Rename(f.Name(), path) != nil {
		_ = os.Remove(f.Name())
	}
}

// EstimateTokens is an estimate: the larger of UTF-8 bytes/4 and 1.3 pieces
// per whitespace word. No tokenizer is linked into the short-lived hook.
func EstimateTokens(s string) int { return max((len(s)+3)/4, (len(strings.Fields(s))*13+9)/10) }
func label(e *Entry, level string) string {
	switch level {
	case "hint":
		return "[hint, seen once]"
	case "team":
		source := e.Evidence
		if source == "ci" {
			source = "CI"
		}
		if source == "person" {
			source = "a person"
		}
		return "[team, from " + source + "]"
	default:
		if e.Source.Type != "person" {
			return "[personal, from " + e.Evidence + "]"
		}
		d, _ := time.Parse("2006-01-02", e.Created)
		return "[you said, " + d.Format("2 Jan") + "]"
	}
}
