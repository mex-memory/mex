// Package noteguard withholds personal snapshots during copy-and-swap publication.
// Readers never recover or mutate a store.
package noteguard

import (
	"errors"
	"io"
	"os"
	"path/filepath"
)

func Token(notes string) (string, error) {
	parent := filepath.Dir(notes)
	if _, err := os.Lstat(filepath.Join(parent, "notes.pending")); err == nil {
		return "", errors.New("personal notes are being consolidated")
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	path := filepath.Join(parent, "notes.revision")
	before, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if !before.Mode().IsRegular() || before.Size() > 64 {
		return "", errors.New("invalid personal note revision")
	}
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil || !os.SameFile(before, opened) {
		return "", errors.New("personal note revision changed")
	}
	b, err := io.ReadAll(io.LimitReader(f, 65))
	if err != nil || len(b) > 64 {
		return "", errors.New("invalid personal note revision")
	}
	return string(b), nil
}

func Begin(notes string) (func() error, error) {
	before, err := Token(notes)
	if err != nil {
		return nil, err
	}
	return func() error {
		after, err := Token(notes)
		if err != nil {
			return err
		}
		if before != after {
			return errors.New("personal notes changed while being read")
		}
		return nil
	}, nil
}
