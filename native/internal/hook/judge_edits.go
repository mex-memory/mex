package hook

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record/place"
)

const judgeEditBytes = 64 << 10

type judgePosition struct {
	Branch string `json:"branch"`
	Head   string `json:"head"`
}
type judgeEdit struct {
	Path   string  `json:"path"`
	Before *string `json:"before"`
	After  *string `json:"after"`
}
type judgeEditPending struct {
	Tool  string      `json:"tool"`
	Files []judgeEdit `json:"files"`
}
type judgeEdits struct {
	Version   int               `json:"version"`
	Project   string            `json:"project_id"`
	Checkout  string            `json:"checkout"`
	Agent     string            `json:"agent"`
	SessionID string            `json:"session_id"`
	Position  judgePosition     `json:"position"`
	Edits     []judgeEdit       `json:"edits"`
	Pending   *judgeEditPending `json:"pending,omitempty"`
}

func judgeHash(data []byte) string {
	sum := sha256.Sum256(data)
	return "sha256:" + hex.EncodeToString(sum[:])
}

func boundedJudgeRead(name string, max int64) ([]byte, error) {
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

var judgeOID = regexp.MustCompile(`^[a-f0-9]{40}([a-f0-9]{24})?$`)

// Read Git metadata, never execute a repository command on a hook. Unusual or
// unavailable metadata means no ownership proof, not an assumed branch.
func judgeGitPosition(checkout string) (judgePosition, bool) {
	dir := filepath.Join(checkout, ".git")
	info, err := os.Lstat(dir)
	if err != nil || info.Mode()&os.ModeSymlink != 0 {
		return judgePosition{}, false
	}
	if !info.IsDir() {
		data, err := boundedJudgeRead(dir, 4096)
		if err != nil || !strings.HasPrefix(string(data), "gitdir: ") {
			return judgePosition{}, false
		}
		dir = strings.TrimSpace(strings.TrimPrefix(string(data), "gitdir: "))
		if !filepath.IsAbs(dir) {
			dir = filepath.Join(checkout, dir)
		}
	}
	data, err := boundedJudgeRead(filepath.Join(dir, "HEAD"), 4096)
	if err != nil {
		return judgePosition{}, false
	}
	ref := strings.TrimSpace(strings.TrimPrefix(string(data), "ref: "))
	if !strings.HasPrefix(string(data), "ref: ") || !strings.HasPrefix(ref, "refs/heads/") || strings.Contains(ref, "..") || strings.ContainsAny(ref, "\\\x00\r\n\t ") {
		return judgePosition{}, false
	}
	common := dir
	if data, err := boundedJudgeRead(filepath.Join(dir, "commondir"), 4096); err == nil {
		common = strings.TrimSpace(string(data))
		if !filepath.IsAbs(common) {
			common = filepath.Join(dir, common)
		}
	}
	head, err := boundedJudgeRead(filepath.Join(common, filepath.FromSlash(ref)), 128)
	if err == nil && judgeOID.MatchString(strings.TrimSpace(string(head))) {
		return judgePosition{ref, strings.TrimSpace(string(head))}, true
	}
	packed, err := boundedJudgeRead(filepath.Join(common, "packed-refs"), 256<<10)
	if err != nil {
		return judgePosition{}, false
	}
	for _, line := range strings.Split(string(packed), "\n") {
		words := strings.Split(line, " ")
		if len(words) == 2 && words[1] == ref && judgeOID.MatchString(words[0]) {
			return judgePosition{ref, words[0]}, true
		}
	}
	return judgePosition{}, false
}

func writeJudgeLocal(root *os.Root, dir, name string, data []byte) bool {
	if root.MkdirAll(dir, 0o700) != nil {
		return false
	}
	info, err := root.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return false
	}
	tmp := filepath.Join(dir, ".write-"+rand.Text())
	f, err := root.OpenFile(tmp, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return false
	}
	defer root.Remove(tmp)
	_, err = f.Write(data)
	closed := f.Close()
	return err == nil && closed == nil && root.Rename(tmp, filepath.Join(dir, name)) == nil
}

// Hash-only provenance is separate from proximity hints. Reads, shell commands,
// failed tools and unpaired post hooks cannot claim an edit. A single bounded
// checkout file intentionally loses ambiguous concurrent sessions' proofs.
func noteJudgeEdits(ev contract.Event, directory string) {
	if directory == "" || ev.Checkout == "" || ev.ProjectID == "" || ev.SessionID == "" || len(ev.SessionID) > 512 || ev.AgentID != "" ||
		(ev.Agent != "claude-code" && ev.Agent != "codex") || ev.Tool == nil || (ev.Kind != contract.PreTool && ev.Kind != contract.PostTool) {
		return
	}
	move := ev.Tool.Name == contract.ToolShell && movesGit(ev.Tool.Input.Command)
	if !move && ev.Tool.Name != contract.ToolEdit && ev.Tool.Name != contract.ToolWrite && ev.Tool.Name != contract.ToolPatch {
		return
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return
	}
	defer root.Close()
	if root.MkdirAll("judge-edits", 0o700) != nil {
		return
	}
	info, err := root.Lstat("judge-edits")
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return
	}
	name := filepath.Join("judge-edits", place.ShortHash(ev.Checkout)+".json")
	lock := name + ".lock"
	if stat, err := root.Lstat(lock); err == nil && time.Since(stat.ModTime()) > 30*time.Second {
		_ = root.Remove(lock)
	}
	l, err := root.OpenFile(lock, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return
	}
	_ = l.Close()
	defer root.Remove(lock)
	if move {
		_ = root.Remove(name)
		return
	}
	observed := *ev.Tool
	if observed.Output == nil {
		observed.Output = &contract.ToolOutput{}
	}
	edits := editsOf(observed)
	if len(edits) == 0 || len(edits) > 128 {
		return
	}
	at, ok := judgeGitPosition(ev.Checkout)
	if !ok {
		_ = root.Remove(name)
		return
	}
	state := judgeEdits{Version: 1, Project: ev.ProjectID, Checkout: ev.Checkout, Agent: ev.Agent, SessionID: ev.SessionID, Position: at, Edits: []judgeEdit{}}
	if info, err := root.Lstat(name); err == nil && info.Mode().IsRegular() && info.Size() <= judgeEditBytes {
		f, err := root.Open(name)
		if err != nil {
			return
		}
		data, readErr := io.ReadAll(io.LimitReader(f, judgeEditBytes+1))
		_ = f.Close()
		var old judgeEdits
		if readErr == nil && len(data) <= judgeEditBytes && json.Unmarshal(data, &old) == nil && old.Version == 1 && old.Project == ev.ProjectID && old.Checkout == ev.Checkout && old.Agent == ev.Agent && old.SessionID == ev.SessionID && old.Position == at && len(old.Edits) <= 128 && (old.Pending == nil || len(old.Pending.Files) <= 128) {
			state = old
		}
	}
	tool, _ := json.Marshal(struct {
		Name  contract.ToolName
		Input contract.ToolInput
	}{ev.Tool.Name, ev.Tool.Input})
	token := judgeHash(tool)
	checkout, err := os.OpenRoot(ev.Checkout)
	if err != nil {
		return
	}
	defer checkout.Close()
	if ev.Kind == contract.PreTool {
		state.Pending = &judgeEditPending{Tool: token, Files: []judgeEdit{}}
		for _, edit := range edits {
			rel, ok := place.RelativeToCheckout(ev.Checkout, edit.path)
			if !ok || len(rel) > 512 {
				continue
			}
			before, beforeHash, ok := judgeFile(checkout, rel)
			if !ok {
				continue
			}
			after, ok := judgeExpected(*ev.Tool, edit.path, string(before))
			if !ok || len(after) > judgeEditBytes {
				continue
			}
			var afterHash *string
			patch, _ := judgePatchFile(*ev.Tool, edit.path)
			if ev.Tool.Name != contract.ToolPatch || patch.Kind != "delete" {
				h := judgeHash([]byte(after))
				afterHash = &h
			}
			state.Pending.Files = append(state.Pending.Files, judgeEdit{filepath.ToSlash(rel), beforeHash, afterHash})
		}
	} else {
		if state.Pending == nil || state.Pending.Tool != token {
			return
		}
		if ev.Tool.Output != nil && ev.Tool.Output.OK {
			for _, edit := range state.Pending.Files {
				_, afterHash, ok := judgeFile(checkout, filepath.FromSlash(edit.Path))
				if !ok || !sameJudgeHash(afterHash, edit.After) {
					continue
				}
				found := false
				for i, prior := range state.Edits {
					if prior.Path != edit.Path {
						continue
					}
					found = true
					if sameJudgeHash(prior.After, edit.Before) {
						edit.Before = prior.Before
					}
					state.Edits[i] = edit
					break
				}
				if !found && len(state.Edits) < 128 {
					state.Edits = append(state.Edits, edit)
				}
			}
		}
		state.Pending = nil
	}
	if current, ok := judgeGitPosition(ev.Checkout); !ok || current != at {
		_ = root.Remove(name)
		return
	}
	data, err := json.Marshal(state)
	if err != nil || len(data) > judgeEditBytes || !writeJudgeLocal(root, "judge-edits", filepath.Base(name), data) {
		_ = root.Remove(name)
	}
}

func sameJudgeHash(a, b *string) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}

func judgeFile(root *os.Root, path string) ([]byte, *string, bool) {
	info, err := root.Lstat(path)
	if os.IsNotExist(err) {
		return nil, nil, true
	}
	if err != nil || !info.Mode().IsRegular() || info.Size() > judgeEditBytes {
		return nil, nil, false
	}
	f, err := root.Open(path)
	if err != nil {
		return nil, nil, false
	}
	data, err := io.ReadAll(io.LimitReader(f, judgeEditBytes+1))
	_ = f.Close()
	if err != nil || len(data) > judgeEditBytes {
		return nil, nil, false
	}
	h := judgeHash(data)
	return data, &h, true
}

// Compute exact expected bytes from the explicit edit, so unrelated edits
// between pre and post cannot be mistaken for this tool's work.
func judgeExpected(tool contract.Tool, path, before string) (string, bool) {
	switch tool.Name {
	case contract.ToolWrite:
		if tool.Input.Content != nil {
			return *tool.Input.Content, true
		}
	case contract.ToolEdit:
		if tool.Input.Old != nil && tool.Input.New != nil && *tool.Input.Old != "" && strings.Count(before, *tool.Input.Old) == 1 {
			return strings.Replace(before, *tool.Input.Old, *tool.Input.New, 1), true
		}
	case contract.ToolPatch:
		file, ok := judgePatchFile(tool, path)
		if !ok {
			return "", false
		}
		if file.Kind == "delete" {
			return "", true
		}
		for _, hunk := range file.Hunks {
			if hunk.Old == "" {
				if before != "" {
					return "", false
				}
				before = hunk.New
				continue
			}
			if strings.Count(before, hunk.Old) != 1 {
				return "", false
			}
			before = strings.Replace(before, hunk.Old, hunk.New, 1)
		}
		return before, len(file.Hunks) > 0
	}
	return "", false
}

func judgePatchFile(tool contract.Tool, path string) (contract.PatchFile, bool) {
	var found contract.PatchFile
	n := 0
	for _, file := range tool.Input.Files {
		if file.Path == path {
			found = file
			n++
		}
	}
	return found, n == 1
}
