// Package workset reads the working set the background process computes per
// checkout: files in progress (seeds), files one hop away through imports and
// co-change (hops), branch-name words, and per-file fix history. The hook only
// reads the cached file and the checkout's .git files; it never runs git.
package workset

import (
	"bufio"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/internal/safefile"
	"github.com/mex-memory/mex/native/record/place"
)

const (
	Version = 1
	// MaxAge is how old a set may be before a session start asks for a new
	// one. Uncommitted work changes without moving HEAD.
	MaxAge   = 10 * time.Minute
	maxBytes = 2 << 20
)

type Set struct {
	Version       int      `json:"version"`
	Head          string   `json:"head"`
	Branch        string   `json:"branch"`
	DefaultBranch string   `json:"defaultBranch"`
	Made          string   `json:"made"`
	Seeds         []string `json:"seeds"`
	Hops          []string `json:"hops"`
	Words         []string `json:"words"`
}

// Path is <record>/projects/<id>/working-set/<checkout key>.json, the same key
// the file index uses.
func Path(recordDirectory, project, checkout string) (string, error) {
	if !validComponent(project) {
		return "", errors.New("invalid project")
	}
	key, err := index.CheckoutKey(checkout)
	if err != nil {
		return "", err
	}
	return filepath.Join(recordDirectory, "projects", project, "working-set", key+".json"), nil
}

func validComponent(s string) bool {
	return s != "" && s != "." && s != ".." && len(s) <= 128 && !strings.ContainsAny(s, "/\\:\x00")
}

// Read returns the cached set, or nil when it is missing or unreadable.
func Read(recordDirectory, project, checkout string) *Set {
	p, err := Path(recordDirectory, project, checkout)
	if err != nil {
		return nil
	}
	data, err := readBounded(p, maxBytes)
	if err != nil {
		return nil
	}
	var s Set
	if json.Unmarshal(data, &s) != nil || s.Version != Version || len(s.Seeds) > 1000 || len(s.Hops) > 1000 || len(s.Words) > 64 {
		return nil
	}
	return &s
}

func readBounded(p string, limit int64) ([]byte, error) {
	if !safefile.Regular(p) {
		return nil, os.ErrNotExist
	}
	f, err := os.Open(p)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("too large")
	}
	return data, nil
}

// Head is the checkout's current branch (empty when detached) and commit,
// read from .git without running git. Unknown parts stay empty.
func Head(checkout string) (branch, commit string) {
	gitDir := filepath.Join(checkout, ".git")
	info, err := os.Lstat(gitDir)
	if err != nil {
		return "", ""
	}
	if info.Mode().IsRegular() {
		// A worktree or submodule: ".git" names the real directory.
		data, err := readBounded(gitDir, 4096)
		if err != nil {
			return "", ""
		}
		line := strings.TrimSpace(string(data))
		if !strings.HasPrefix(line, "gitdir:") {
			return "", ""
		}
		gitDir = strings.TrimSpace(strings.TrimPrefix(line, "gitdir:"))
		if !filepath.IsAbs(gitDir) {
			gitDir = filepath.Join(checkout, gitDir)
		}
	} else if !info.IsDir() {
		return "", ""
	}
	data, err := readBounded(filepath.Join(gitDir, "HEAD"), 4096)
	if err != nil {
		return "", ""
	}
	head := strings.TrimSpace(string(data))
	if !strings.HasPrefix(head, "ref:") {
		if isCommit(head) {
			return "", head
		}
		return "", ""
	}
	ref := strings.TrimSpace(strings.TrimPrefix(head, "ref:"))
	if !strings.HasPrefix(ref, "refs/") || strings.Contains(ref, "..") {
		return "", ""
	}
	branch = strings.TrimPrefix(ref, "refs/heads/")
	// Loose refs and packed-refs live in the common directory of a worktree.
	common := gitDir
	if c, err := readBounded(filepath.Join(gitDir, "commondir"), 4096); err == nil {
		dir := strings.TrimSpace(string(c))
		if !filepath.IsAbs(dir) {
			dir = filepath.Join(gitDir, dir)
		}
		common = dir
	}
	for _, dir := range []string{gitDir, common} {
		if data, err := readBounded(filepath.Join(dir, filepath.FromSlash(ref)), 4096); err == nil {
			if sha := strings.TrimSpace(string(data)); isCommit(sha) {
				return branch, sha
			}
		}
	}
	return branch, packedRef(filepath.Join(common, "packed-refs"), ref)
}

func packedRef(p, ref string) string {
	if !safefile.Regular(p) {
		return ""
	}
	f, err := os.Open(p)
	if err != nil {
		return ""
	}
	defer f.Close()
	scanner := bufio.NewScanner(io.LimitReader(f, 8<<20))
	scanner.Buffer(make([]byte, 0, 4096), 4096)
	for scanner.Scan() {
		line := scanner.Text()
		if sha, name, ok := strings.Cut(line, " "); ok && name == ref && isCommit(sha) {
			return sha
		}
	}
	return ""
}

func isCommit(s string) bool {
	if len(s) != 40 && len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// Usable reports whether a cached set describes the branch the checkout is on.
// A set from another branch names the wrong files; one from an older commit
// on this branch is still close, and a refresh is on its way.
func (s *Set) Usable(branch string) bool {
	return s != nil && s.Branch == branch
}

// Stale reports whether a session start should ask for a new set.
func (s *Set) Stale(branch, commit string, now time.Time) bool {
	if s == nil || s.Branch != branch || s.Head != commit {
		return true
	}
	made, err := time.Parse(time.RFC3339Nano, s.Made)
	return err != nil || now.Sub(made) > MaxAge || made.After(now.Add(time.Minute))
}

// PendingMarker is the file whose presence tells the background process that
// requests are waiting. It is checked with one stat.
func PendingMarker(recordDirectory string) string {
	return filepath.Join(recordDirectory, "working-set-pending")
}

// Request asks the background process to recompute one checkout's set. It
// writes only small files under the record directory and never waits.
func Request(recordDirectory, project, checkout string) error {
	if !validComponent(project) {
		return errors.New("invalid project")
	}
	real, err := place.RealPath(checkout)
	if err != nil {
		return err
	}
	root, err := os.OpenRoot(recordDirectory)
	if err != nil {
		return err
	}
	defer root.Close()
	if err = root.Mkdir("working-set-requests", 0o700); err != nil && !os.IsExist(err) {
		return err
	}
	if info, err := root.Lstat("working-set-requests"); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("redirected requests")
	}
	body, err := json.Marshal(map[string]string{"project": project, "root": real})
	if err != nil {
		return err
	}
	name := filepath.Join("working-set-requests", project+"~"+place.ShortHash(real)+".json")
	if info, err := root.Lstat(name); err == nil && !info.Mode().IsRegular() {
		return errors.New("redirected request")
	}
	f, err := root.OpenFile(name, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err = f.Write(body); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if info, err := root.Lstat("working-set-pending"); err == nil && !info.Mode().IsRegular() {
		return errors.New("redirected marker")
	}
	m, err := root.OpenFile("working-set-pending", os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	return m.Close()
}

// pathKey is FNV-1a over the path's UTF-8 bytes, the key the background job
// sorts the fix table by.
func pathKey(p string) uint64 {
	h := uint64(0xcbf29ce484222325)
	for i := 0; i < len(p); i++ {
		h ^= uint64(p[i])
		h *= 0x100000001b3
	}
	return h
}

const fixesMagic = "MXF1"

// Fixes is a file's fix history: fix commits in the window and the time of the
// last one.
type Fixes struct {
	Count int
	Last  time.Time
}

// FixesFor looks one checkout-relative file up in the fix table the
// background job writes beside the working set. It opens one small file and
// binary-searches fixed-size records, so it is cheap enough for an edit
// moment. The checkout must already be canonical.
func FixesFor(recordDirectory, project, checkout, rel string) (Fixes, bool) {
	if !validComponent(project) || rel == "" {
		return Fixes{}, false
	}
	p := filepath.Join(recordDirectory, "projects", project, "working-set", place.ShortHash(checkout)+".fixes")
	if !safefile.Regular(p) {
		return Fixes{}, false
	}
	f, err := os.Open(p)
	if err != nil {
		return Fixes{}, false
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || info.Size() < 4 || (info.Size()-4)%16 != 0 || info.Size() > 4+16*65536 {
		return Fixes{}, false
	}
	head := make([]byte, 4)
	if _, err = f.ReadAt(head, 0); err != nil || string(head) != fixesMagic {
		return Fixes{}, false
	}
	key := pathKey(rel)
	rec := make([]byte, 16)
	lo, hi := int64(0), (info.Size()-4)/16
	for lo < hi {
		mid := (lo + hi) / 2
		if _, err = f.ReadAt(rec, 4+mid*16); err != nil {
			return Fixes{}, false
		}
		k := binary.LittleEndian.Uint64(rec)
		switch {
		case k == key:
			return Fixes{Count: int(binary.LittleEndian.Uint32(rec[8:])), Last: time.Unix(int64(binary.LittleEndian.Uint32(rec[12:])), 0)}, true
		case k < key:
			lo = mid + 1
		default:
			hi = mid
		}
	}
	return Fixes{}, false
}
