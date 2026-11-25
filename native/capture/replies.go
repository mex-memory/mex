package capture

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/mex-memory/mex/native/internal/captureprofile"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record/place"
)

const replyFolder = "filter-replies"
const maxReplyBytes = 12_000

var replyFile = regexp.MustCompile(`^[0-9]{19}\.json$`)
var cacheDirectory = regexp.MustCompile(`^[a-f0-9]{24}$`)

type finalReply struct {
	Version  int    `json:"version"`
	Project  string `json:"project_id"`
	Checkout string `json:"checkout"`
	Agent    string `json:"agent"`
	Session  string `json:"session_id"`
	At       string `json:"at"`
	Text     string `json:"text"`
	For      string `json:"for_prompt_at,omitempty"`
}

func replySlot(ev contract.Event) string {
	key := place.ShortHash(strings.Join([]string{ev.ProjectID, ev.Checkout, ev.Agent, ev.SessionID}, "\x00"))
	return filepath.Join(replyFolder, key)
}

func latestReply(ev contract.Event, env Env) (string, finalReply) {
	var reply finalReply
	folder := replySlot(ev)
	root, err := os.OpenRoot(env.RecordDirectory)
	if err != nil {
		return "", reply
	}
	defer root.Close()
	for _, dir := range []string{replyFolder, folder} {
		info, err := root.Lstat(dir)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return "", reply
		}
	}
	entries, err := root.Open(folder)
	if err != nil {
		return "", reply
	}
	defer entries.Close()
	files, _ := entries.ReadDir(128)
	name := ""
	for _, f := range files {
		if f.Type().IsRegular() && replyFile.MatchString(f.Name()) && f.Name() > name {
			name = f.Name()
		}
	}
	if name == "" || readJSON(filepath.Join(env.RecordDirectory, folder, name), &reply) != nil || reply.Version != 1 ||
		reply.Project != ev.ProjectID || reply.Checkout != ev.Checkout || reply.Agent != ev.Agent || reply.Session != ev.SessionID {
		return "", finalReply{}
	}
	return strings.TrimSuffix(name, ".json"), reply
}

// Once a person replies to the cached text, keep that one pair for the
// finished-session batch. An unpaired acknowledgement must not evict it.
func bindFinalReply(ev contract.Event, env Env) error {
	if ev.AgentID != "" || ev.Prompt == nil || !captureprofile.For(ev.Agent).Cache {
		return nil
	}
	name, reply := latestReply(ev, env)
	stamp := now(env).UTC()
	at, err := time.Parse(time.RFC3339Nano, reply.At)
	if name == "" || reply.Text == "" || reply.For != "" || err != nil || !at.Before(stamp) || stamp.Sub(at) > 24*time.Hour {
		return nil
	}
	reply.For = stamp.Format(time.RFC3339Nano)
	if strings.TrimSpace(ev.Prompt.Text) == "" || Marks(ev, env.getenv) != "" {
		reply.Text = ""
	}
	return filterFile(env.RecordDirectory, replySlot(ev), name, reply)
}

func replyOutside(ev contract.Event) bool {
	t := ev.Tool
	if t == nil {
		return false
	}
	name := strings.ToLower(t.RawName)
	if strings.HasPrefix(name, "mcp_") || strings.HasPrefix(name, "mcp:") || name == "webfetch" || name == "websearch" ||
		name == "web_fetch" || name == "web_search" || name == "google_web_search" {
		return true
	}
	if t.Input.Path == "" || (t.Name != contract.ToolRead && t.Name != contract.ToolSearch && t.Name != contract.ToolGlob) {
		return false
	}
	path := t.Input.Path
	if !filepath.IsAbs(path) {
		path = filepath.Join(ev.Cwd, path)
	}
	if real, err := place.RealPath(path); err == nil {
		path = real
	}
	_, inside := checkoutRelative(ev.Checkout, path)
	return !inside
}

// MarkReplyOutside runs against the session checkout. Tool delivery on the
// same hook may use the checkout of a different target file.
func MarkReplyOutside(ev contract.Event, env Env) error {
	profile := captureprofile.For(ev.Agent)
	if ev.AgentID != "" || !profile.Cache || (profile.Outside != "hook" && profile.Outside != "transcript-and-hook") || !replyOutside(ev) {
		return nil
	}
	key := place.ShortHash(ev.ProjectID + "\x00" + ev.SessionID)
	var meta FilterSession
	if readJSON(filepath.Join(env.RecordDirectory, "filter-sessions", key+".json"), &meta) != nil ||
		meta.Version != 1 || meta.Project != ev.ProjectID || meta.Checkout != ev.Checkout || meta.Agent != ev.Agent || meta.Session != ev.SessionID || meta.PromptAt == "" {
		return nil
	}
	meta.OutsideAt = now(env).UTC().Format(time.RFC3339Nano)
	return filterFile(env.RecordDirectory, "filter-sessions", key, meta)
}

// Store a single completed response per session. Generation filenames let the
// worker delete the one it read without racing a resumed session's new reply.
func saveFinalReply(ev contract.Event, env Env) error {
	if ev.AgentID != "" || !captureprofile.For(ev.Agent).Cache || ev.IncompleteTurn {
		return nil
	}
	lookup := place.ShortHash(ev.ProjectID + "\x00" + ev.SessionID)
	var meta FilterSession
	if readJSON(filepath.Join(env.RecordDirectory, "filter-sessions", lookup+".json"), &meta) != nil ||
		meta.Version != 1 || meta.Project != ev.ProjectID || meta.Checkout != ev.Checkout || meta.Agent != ev.Agent || meta.Session != ev.SessionID {
		return nil
	}
	stamp := now(env).UTC()
	promptAt, err := time.Parse(time.RFC3339Nano, meta.PromptAt)
	if err != nil || !promptAt.Before(stamp) || stamp.Sub(promptAt) > 24*time.Hour {
		return nil
	}
	_, retained := latestReply(ev, env)
	if at, err := time.Parse(time.RFC3339Nano, retained.For); retained.Text != "" && err == nil && at.Before(stamp) && stamp.Sub(at) <= 24*time.Hour {
		return nil
	}
	body := *ev.FinalReply
	// A newer unreadable or withheld reply must not leave an older reply
	// looking like it immediately preceded the next prompt.
	if meta.OutsideAt != "" || !safeChoiceText(body, 1<<20) || strings.TrimSpace(body) == "" {
		body = ""
	}
	transcript := ev.Transcript
	if transcript == "" && !ev.TranscriptDisabled && !ev.CaptureOnly {
		transcript = meta.Transcript
	}
	if info, err := os.Lstat(transcript); err == nil && info.Mode().IsRegular() && info.Size() > 0 {
		body = ""
	}
	reply := finalReply{Version: 1, Project: ev.ProjectID, Checkout: ev.Checkout, Agent: ev.Agent, Session: ev.SessionID,
		At: stamp.Format(time.RFC3339Nano), Text: clip(body, maxReplyBytes)}
	// Reserve space for the prompt timestamp. Escapes can take more space than the raw reply.
	if data, err := json.Marshal(reply); err != nil || len(data)+64 > filterFileBytes {
		reply.Text = ""
	}
	folder := replySlot(ev)
	if reply.Text == "" {
		if _, err := os.Lstat(filepath.Join(env.RecordDirectory, folder)); errors.Is(err, os.ErrNotExist) {
			return nil
		}
	}
	name := strconv.FormatInt(stamp.UnixNano(), 10)
	if err := writeFilterFile(env.RecordDirectory, folder, name, reply, true); err != nil {
		return err
	}
	root, err := os.OpenRoot(env.RecordDirectory)
	if err != nil {
		return err
	}
	defer root.Close()
	return removeOlderReplies(root, folder, name+".json")
}

func removeOlderReplies(root *os.Root, folder, newest string) error {
	dir, err := root.Open(folder)
	if err != nil {
		return err
	}
	defer dir.Close()
	entries, err := dir.ReadDir(128)
	if err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	for _, entry := range entries {
		if entry.Name() < newest && replyFile.MatchString(entry.Name()) && entry.Type().IsRegular() {
			_ = root.Remove(filepath.Join(folder, entry.Name()))
		}
	}
	return nil
}

func pruneReplyCaches(env Env) {
	root, err := os.OpenRoot(env.RecordDirectory)
	if err != nil {
		return
	}
	defer root.Close()
	base, err := root.Lstat(replyFolder)
	if err != nil || !base.IsDir() || base.Mode()&os.ModeSymlink != 0 {
		return
	}
	dir, err := root.Open(replyFolder)
	if err != nil {
		return
	}
	defer dir.Close()
	entries, _ := dir.ReadDir(128)
	cutoff := now(env).Add(-24 * time.Hour)
	for _, entry := range entries {
		if !entry.IsDir() || !cacheDirectory.MatchString(entry.Name()) {
			continue
		}
		if info, err := entry.Info(); err == nil && info.ModTime().Before(cutoff) {
			folder := filepath.Join(replyFolder, entry.Name())
			_ = removeOlderReplies(root, folder, strconv.FormatInt(cutoff.UnixNano(), 10)+".json")
			_ = root.Remove(folder)
		}
	}
}
