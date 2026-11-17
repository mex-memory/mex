// Package brief owns the small session-start projection and native coverage.
// It reads canonical entries and rechecks their claims; it never runs repository
// commands, starts a model, or changes repository files.
package brief

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path"
	"strings"
)

const (
	maxScanBytes = 8 << 20
	maxFiles     = 200
	maxRuleBytes = 256 << 10
)

func hash(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func safePath(name string) bool {
	if name == "" || len(name) > 2048 || strings.ContainsAny(name, "\\:\x00\r\n") || strings.HasPrefix(name, "/") {
		return false
	}
	for _, part := range strings.Split(name, "/") {
		if part == "" || part == "." || part == ".." {
			return false
		}
	}
	return true
}

// Even in-root links are refused: native files and entry stores are real files.
// os.Root also confines the open if a parent is replaced during the operation.
func readFile(root *os.Root, name string, limit int) ([]byte, error) {
	if root == nil || !safePath(name) {
		return nil, errors.New("unsafe path")
	}
	parts := strings.Split(name, "/")
	for i := range parts {
		info, err := root.Lstat(strings.Join(parts[:i+1], "/"))
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			return nil, errors.New("unavailable file")
		}
	}
	f, err := root.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > int64(limit) {
		return nil, errors.New("not a bounded regular file")
	}
	data, err := io.ReadAll(io.LimitReader(f, int64(limit)+1))
	if err != nil || len(data) > limit {
		return nil, errors.New("file exceeds limit")
	}
	after, statErr := f.Stat()
	leaf, leafErr := root.Lstat(name)
	if statErr != nil || leafErr != nil || !leaf.Mode().IsRegular() || !os.SameFile(info, leaf) || info.Size() != after.Size() || int64(len(data)) != after.Size() || !info.ModTime().Equal(after.ModTime()) {
		return nil, errors.New("file changed during read")
	}
	return data, nil
}

// walkStore stops before retaining an unbounded corpus, and never follows links.
type scanBudget struct{ bytes, files int }

func walkStore(root *os.Root, folder string, depth int, remaining *scanBudget, visit func(string, []byte)) error {
	if root == nil {
		return nil
	}
	parts := strings.Split(folder, "/")
	for i := range parts {
		info, err := root.Lstat(strings.Join(parts[:i+1], "/"))
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("unsafe entry store")
		}
	}
	dir, err := root.Open(folder)
	if err != nil {
		return err
	}
	defer dir.Close()
	for {
		children, err := dir.ReadDir(128)
		for _, child := range children {
			remaining.files--
			if remaining.files < 0 {
				return errors.New("entry scan exceeds limit")
			}
			name := path.Join(folder, child.Name())
			if child.Type()&os.ModeSymlink != 0 {
				continue
			}
			if child.IsDir() && depth > 0 {
				if err := walkStore(root, name, depth-1, remaining, visit); err != nil {
					return err
				}
			} else if child.Type().IsRegular() && strings.HasSuffix(child.Name(), ".md") && !strings.HasPrefix(child.Name(), ".") {
				if remaining.bytes <= 0 {
					return errors.New("entry scan exceeds limit")
				}
				data, err := readFile(root, name, min(64<<10, remaining.bytes))
				if err == nil {
					remaining.bytes -= len(data)
					visit(name, data)
				}
			}
		}
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
	}
}
