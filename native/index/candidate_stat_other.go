//go:build !windows

package index

import (
	"os"
	"path/filepath"
	"time"
)

type candidateStats struct{ *os.Root }

func openCandidateStats(path string) (candidateStats, error) {
	root, err := os.OpenRoot(path)
	return candidateStats{root}, err
}

func (s candidateStats) mtime(path string) (time.Time, error) {
	info, err := s.Lstat(filepath.FromSlash(path))
	if err != nil || !info.Mode().IsRegular() {
		return time.Time{}, err
	}
	return info.ModTime(), nil
}
