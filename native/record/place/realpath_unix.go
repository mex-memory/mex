//go:build !windows

package place

import "path/filepath"

func platformRealPath(path string) (string, error) { return filepath.EvalSymlinks(path) }
