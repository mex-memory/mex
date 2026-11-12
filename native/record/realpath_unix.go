//go:build !windows

package record

import "path/filepath"

func platformRealPath(path string) (string, error) { return filepath.EvalSymlinks(path) }
