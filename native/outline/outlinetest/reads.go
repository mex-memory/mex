// Package outlinetest loads the saved reads in native/outline/testdata/reads
// for replay tests. It is test support, never linked into the hook.
package outlinetest

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"github.com/mex-memory/mex/native/index/shift"
)

// SavedRead is one fixture: a file, its outline as the file index stores it
// (made by the Node indexer), and a prompt.
type SavedRead struct {
	Name    string
	Content string
	Symbols []shift.Symbol
	Prompt  string
}

// Dir is the fixtures folder, wherever the test runs from.
func Dir() string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "testdata", "reads")
}

// SavedReads loads every fixture.
func SavedReads() ([]SavedRead, error) {
	dir := Dir()
	files, err := filepath.Glob(filepath.Join(dir, "*.src"))
	if err != nil || len(files) == 0 {
		return nil, fmt.Errorf("no saved reads in %s: %v", dir, err)
	}
	var out []SavedRead
	for _, f := range files {
		name := strings.TrimSuffix(filepath.Base(f), ".src")
		content, err := os.ReadFile(f)
		if err != nil {
			return nil, err
		}
		raw, err := os.ReadFile(filepath.Join(dir, name+".outline.json"))
		if err != nil {
			return nil, err
		}
		var symbols []shift.Symbol
		if err := json.Unmarshal(raw, &symbols); err != nil {
			return nil, err
		}
		prompt, _ := os.ReadFile(filepath.Join(dir, name+".prompt"))
		out = append(out, SavedRead{Name: name, Content: string(content), Symbols: symbols, Prompt: strings.TrimSpace(string(prompt))})
	}
	return out, nil
}
