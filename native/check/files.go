package check

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"strings"
)

// MaxFileBytes is the largest repository file a check reads, the file
// index's "too big" limit.
const MaxFileBytes = 4 << 20

var (
	errMissing    = errors.New("file is missing")
	errUnreadable = errors.New("file is unreadable")
)

// files reads repository files once per evaluation, confined to the checkout.
type files struct {
	root     *os.Root
	cache    map[string]fileRead
	maxBytes int64 // zero uses the ordinary evaluator bound
}

type fileRead struct {
	data []byte
	hash string // "sha256:<hex>", "" when not read
	err  error  // nil, errMissing or errUnreadable
}

func openFiles(checkout string) (*files, error) {
	root, err := os.OpenRoot(checkout)
	if err != nil {
		return nil, err
	}
	return &files{root: root, cache: map[string]fileRead{}}, nil
}

func (f *files) Close() error {
	if f.root == nil {
		return nil
	}
	return f.root.Close()
}

// safeRelative accepts the entry codec's repository-relative file paths.
func safeRelative(path string) bool {
	if path == "" || strings.ContainsAny(path, "\\\x00") || strings.HasPrefix(path, "/") || (len(path) > 1 && path[1] == ':') {
		return false
	}
	for _, part := range strings.Split(path, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

// read returns a file's bytes and hash. A path that escapes the checkout, a
// directory, or a file over the limit is unreadable; an absent file is missing.
func (f *files) read(path string) fileRead {
	if r, ok := f.cache[path]; ok {
		return r
	}
	r := f.load(path)
	f.cache[path] = r
	return r
}

func (f *files) load(path string) fileRead {
	if !safeRelative(path) {
		return fileRead{err: errUnreadable}
	}
	if f.root == nil {
		return fileRead{err: errUnreadable}
	}
	file, err := f.root.Open(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return fileRead{err: errMissing}
		}
		return fileRead{err: errUnreadable}
	}
	defer file.Close()
	limit := f.maxBytes
	if limit == 0 {
		limit = MaxFileBytes
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > limit {
		return fileRead{err: errUnreadable}
	}
	data, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil || int64(len(data)) > limit {
		return fileRead{err: errUnreadable}
	}
	return fileRead{data: data, hash: hashBytes(data)}
}

// same reports whether the file still has the recorded content. A checkout may
// give the same commit other line endings than the ones it was recorded with.
func (r fileRead) same(want string) bool {
	if r.hash == want || r.err != nil {
		return r.hash == want
	}
	lf := bytes.ReplaceAll(r.data, []byte("\r\n"), []byte("\n"))
	return hashBytes(lf) == want || hashBytes(bytes.ReplaceAll(lf, []byte("\n"), []byte("\r\n"))) == want
}

func hashBytes(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}
