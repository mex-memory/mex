package brief

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/mex-memory/mex/native/record/place"
)

type observed struct {
	Version   int            `json:"version"`
	Checkout  string         `json:"checkout"`
	ProjectID string         `json:"project_id"`
	SessionID string         `json:"session_id"`
	AgentID   string         `json:"agent_id"`
	Files     []CoverageFile `json:"files"`
}

func observedPath(opts Options) string {
	return "native-coverage/" + place.ShortHash(opts.Checkout+"\x00"+opts.Agent+"\x00"+opts.SessionID+"\x00"+opts.AgentID) + ".json"
}

func readObserved(store *os.Root, opts Options) observed {
	var found observed
	data, err := readFile(store, observedPath(opts), 128<<10)
	if err != nil || json.Unmarshal(data, &found) != nil || found.Version != 1 || found.Checkout != opts.Checkout || found.ProjectID != opts.ProjectID || found.SessionID != opts.SessionID || found.AgentID != opts.AgentID || len(found.Files) > maxFiles {
		return observed{Version: 1, Checkout: opts.Checkout, ProjectID: opts.ProjectID, SessionID: opts.SessionID, AgentID: opts.AgentID}
	}
	return found
}

func addObserved(c *Coverage, root *os.Root, opts Options) {
	if opts.Agent != "claude-code" || opts.RecordDirectory == "" || opts.SessionID == "" {
		return
	}
	store, err := os.OpenRoot(opts.RecordDirectory)
	if err != nil {
		return
	}
	defer store.Close()
	for _, f := range readObserved(store, opts).Files {
		body, err := readFile(root, f.Path, maxRuleBytes)
		if err == nil && hash(body) == f.Hash {
			c.Files = append(c.Files, f)
		}
	}
}

// ObserveLoaded records only native metadata for a file already authenticated by
// the rule scan or generated manifest. The profile supplies the real load path.
// No transcript text is kept, and an event cannot claim another checkout's file.
func ObserveLoaded(opts Options, loaded string) {
	if opts.Agent != "claude-code" || opts.SessionID == "" || len(opts.SessionID) > 512 || opts.RecordDirectory == "" {
		return
	}
	canonical, err := place.RealPath(opts.Checkout)
	if err != nil {
		return
	}
	opts.Checkout = canonical
	rel, ok := place.RelativeToCheckout(opts.Checkout, loaded)
	if !ok {
		return
	}
	coverage := ReadCoverage(Options{Checkout: opts.Checkout, MexHome: opts.MexHome, ProjectID: opts.ProjectID, Agent: opts.Agent})
	var file *CoverageFile
	for _, f := range coverage.Files {
		if f.Path == rel {
			f.Agents = []string{"claude-code"}
			file = &f
			break
		}
	}
	if file == nil {
		return
	}
	store, err := os.OpenRoot(opts.RecordDirectory)
	if err != nil {
		return
	}
	defer store.Close()
	if err := store.Mkdir("native-coverage", 0700); err != nil && !os.IsExist(err) {
		return
	}
	info, err := store.Lstat("native-coverage")
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return
	}
	name := observedPath(opts)
	if _, err := store.Lstat(name); os.IsNotExist(err) {
		dir, err := store.Open("native-coverage")
		if err != nil {
			return
		}
		children, readErr := dir.ReadDir(513)
		dir.Close()
		if readErr != nil && readErr != io.EOF {
			return
		}
		if len(children) >= 512 {
			return
		}
	}
	lock := name + ".lock"
	if err := store.Mkdir(lock, 0700); err != nil {
		if info, err := store.Lstat(lock); err != nil || !info.IsDir() || time.Since(info.ModTime()) < time.Minute {
			return
		}
		if store.Remove(lock) != nil || store.Mkdir(lock, 0700) != nil {
			return
		}
	}
	defer store.Remove(lock)
	state := readObserved(store, opts)
	replaced := false
	for i := range state.Files {
		if state.Files[i].Path == rel {
			state.Files[i] = *file
			replaced = true
			break
		}
	}
	if !replaced {
		if len(state.Files) >= maxFiles {
			return
		}
		state.Files = append(state.Files, *file)
	}
	data, err := json.Marshal(state)
	if err != nil || len(data) > 128<<10 {
		return
	}
	temporary := name + ".tmp"
	f, err := store.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return
	}
	defer store.Remove(temporary)
	_, werr := f.Write(data)
	cerr := f.Close()
	if werr == nil && cerr == nil {
		_ = store.Rename(temporary, name)
	}
	// Bound retained observations to recent sessions. Never recurse or follow links.
	dir, err := store.Open("native-coverage")
	if err != nil {
		return
	}
	defer dir.Close()
	children, _ := dir.ReadDir(512)
	for _, child := range children {
		if info, err := child.Info(); err == nil && info.Mode().IsRegular() && time.Since(info.ModTime()) > 7*24*time.Hour {
			_ = store.Remove(filepath.ToSlash(filepath.Join("native-coverage", child.Name())))
		}
	}
}
