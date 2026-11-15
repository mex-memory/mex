// Package gitstate reads bounded Git identity metadata without executing Git.
package gitstate

import (
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type Position struct {
	Branch string `json:"branch"`
	Head   string `json:"head"`
}

func readRegular(name string, max int64) ([]byte, error) {
	expected, err := os.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !expected.Mode().IsRegular() || expected.Size() > max {
		return nil, os.ErrInvalid
	}
	f, err := os.Open(name)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > max || !os.SameFile(expected, info) {
		return nil, os.ErrInvalid
	}
	data, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil || int64(len(data)) > max {
		return nil, os.ErrInvalid
	}
	return data, nil
}

var oid = regexp.MustCompile(`^[a-f0-9]{40}([a-f0-9]{24})?$`)

// Read Git metadata, never execute a repository command on a hook. Unusual or
// unavailable metadata means no ownership proof, not an assumed branch.
func Read(checkout string) (Position, bool) {
	dir := filepath.Join(checkout, ".git")
	info, err := os.Lstat(dir)
	if err != nil || info.Mode()&os.ModeSymlink != 0 {
		return Position{}, false
	}
	if !info.IsDir() {
		data, err := readRegular(dir, 4096)
		if err != nil || !strings.HasPrefix(string(data), "gitdir: ") {
			return Position{}, false
		}
		dir = strings.TrimSpace(strings.TrimPrefix(string(data), "gitdir: "))
		if !filepath.IsAbs(dir) {
			dir = filepath.Join(checkout, dir)
		}
	}
	data, err := readRegular(filepath.Join(dir, "HEAD"), 4096)
	if err != nil {
		return Position{}, false
	}
	ref := strings.TrimSpace(strings.TrimPrefix(string(data), "ref: "))
	if !strings.HasPrefix(string(data), "ref: ") || !strings.HasPrefix(ref, "refs/heads/") || strings.Contains(ref, "..") || strings.ContainsAny(ref, "\\\x00\r\n\t ") {
		return Position{}, false
	}
	common := dir
	if data, err := readRegular(filepath.Join(dir, "commondir"), 4096); err == nil {
		common = strings.TrimSpace(string(data))
		if !filepath.IsAbs(common) {
			common = filepath.Join(dir, common)
		}
	}
	head, err := readRegular(filepath.Join(common, filepath.FromSlash(ref)), 128)
	if err == nil && oid.MatchString(strings.TrimSpace(string(head))) {
		return Position{ref, strings.TrimSpace(string(head))}, true
	}
	packed, err := readRegular(filepath.Join(common, "packed-refs"), 256<<10)
	if err != nil {
		return Position{}, false
	}
	for _, line := range strings.Split(string(packed), "\n") {
		words := strings.Split(line, " ")
		if len(words) == 2 && words[1] == ref && oid.MatchString(words[0]) {
			return Position{ref, words[0]}, true
		}
	}
	return Position{}, false
}
