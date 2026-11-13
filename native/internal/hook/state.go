package hook

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"
)

// home is where the shim looks for the person's files. Tests point it at a
// temp folder through the environment.
type home struct {
	user  string // the person's home folder
	mex   string // MEX's folder: <MEX_HOME>/.mex, else ~/.mex (the same rule as Node's mexHomeDir)
	codex string // Codex's folder: CODEX_HOME, else ~/.codex
}

func homeFrom(getenv Env) home {
	user := getenv("HOME")
	if runtime.GOOS == "windows" || user == "" {
		if p := getenv("USERPROFILE"); p != "" {
			user = p
		}
	}
	h := home{user: user}
	if base := strings.TrimSpace(getenv("MEX_HOME")); base != "" {
		h.mex = filepath.Join(base, ".mex")
	} else if user != "" {
		h.mex = filepath.Join(user, ".mex")
	}
	if codex := strings.TrimSpace(getenv("CODEX_HOME")); codex != "" {
		h.codex = codex
	} else if user != "" {
		h.codex = filepath.Join(user, ".codex")
	}
	return h
}

// mexInstalled reports whether MEX's folder exists. The shim never creates it.
func (h home) mexInstalled() bool {
	if h.mex == "" {
		return false
	}
	st, err := os.Stat(h.mex)
	return err == nil && st.IsDir()
}

// ---------------------------------------------------------------------------
// Heartbeat: one small file per agent session, touched on every hook call, so
// MEX can tell which agents are actually running its hooks.
// ---------------------------------------------------------------------------

const heartbeatMaxAge = 7 * 24 * time.Hour

// safeName keeps a name usable as one file name on every OS.
func safeName(s string) string {
	b := []byte(s)
	for i, c := range b {
		ok := c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == '-'
		if !ok {
			b[i] = '_'
		}
	}
	if len(b) == 0 || string(b) == "." || string(b) == ".." {
		return "_"
	}
	return string(b)
}

func (h home) heartbeatDir(agent string) string {
	return filepath.Join(h.mex, "heartbeats", safeName(agent))
}

type heartbeatFile struct {
	Agent     string `json:"agent"`
	SessionID string `json:"session_id"`
	Cwd       string `json:"cwd"`
	Started   string `json:"started"`
}

// beat records that a session's hooks ran. The file's modification time is the
// last call; its contents say which session it is. Errors are ignored. Callers
// check that MEX is installed first: this would create its folder otherwise.
func (h home) beat(agent, sessionID, cwd string, sessionStart bool, now time.Time) {
	if sessionID == "" {
		return
	}
	dir := h.heartbeatDir(agent)
	file := filepath.Join(dir, safeName(sessionID))
	if os.Chtimes(file, now, now) == nil {
		return
	}
	if os.MkdirAll(dir, 0o700) != nil {
		return
	}
	body, _ := json.Marshal(heartbeatFile{Agent: agent, SessionID: sessionID, Cwd: cwd, Started: now.UTC().Format(time.RFC3339)})
	_ = os.WriteFile(file, body, 0o600)
	_ = os.Chtimes(file, now, now)
	if sessionStart {
		h.pruneHeartbeats(dir, now)
	}
}

func (h home) pruneHeartbeats(dir string, now time.Time) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if info, err := e.Info(); err == nil && now.Sub(info.ModTime()) > heartbeatMaxAge {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}

// lastBeat is the newest heartbeat for an agent, or zero.
func (h home) lastBeat(agent string) (time.Time, int) {
	entries, err := os.ReadDir(h.heartbeatDir(agent))
	if err != nil {
		return time.Time{}, 0
	}
	var last time.Time
	for _, e := range entries {
		if info, err := e.Info(); err == nil && info.ModTime().After(last) {
			last = info.ModTime()
		}
	}
	return last, len(entries)
}

// ---------------------------------------------------------------------------
// Policy switches: settings that stop an agent from running MEX's hooks.
// ---------------------------------------------------------------------------

// claudeManagedFolder is where Claude Code reads managed settings files per OS
// (docs, 13 Nov 2026): managed-settings.json, then managed-settings.d/*.json in
// name order. The macOS profile and the Windows registry are also policy
// sources; the shim can't read those cheaply, so --status doesn't report them.
var claudeManagedFolder = func(goos string) string {
	switch goos {
	case "windows":
		return `C:\Program Files\ClaudeCode`
	case "darwin":
		return "/Library/Application Support/ClaudeCode"
	default:
		return "/etc/claude-code"
	}
}

// claudeManagedSettings lists the managed settings files in the order Claude
// Code merges them.
func claudeManagedSettings(goos string) []string {
	folder := claudeManagedFolder(goos)
	files := []string{filepath.Join(folder, "managed-settings.json")}
	if extra, err := filepath.Glob(filepath.Join(folder, "managed-settings.d", "*.json")); err == nil {
		sort.Strings(extra)
		files = append(files, extra...)
	}
	return files
}

// hooksOff lists the switches that turn MEX's hooks off for an agent, each as
// "<file>: <setting>". Unreadable files count as "not set".
func (h home) hooksOff(agent, goos string) []string {
	var off []string
	switch agent {
	case "claude-code":
		user := filepath.Join(h.user, ".claude", "settings.json")
		if jsonTrue(user, "disableAllHooks") {
			off = append(off, user+": disableAllHooks")
		}
		for _, managed := range claudeManagedSettings(goos) {
			if jsonTrue(managed, "disableAllHooks") {
				off = append(off, managed+": disableAllHooks")
			}
			if jsonTrue(managed, "allowManagedHooksOnly") {
				off = append(off, managed+": allowManagedHooksOnly")
			}
		}
	case "codex":
		// The feature switch lives in config.toml; the managed-only switch
		// belongs in requirements.toml (docs, 13 Nov 2026). The system-wide
		// requirements folder isn't documented, so only CODEX_HOME's is read.
		cfg := filepath.Join(h.codex, "config.toml")
		values := tomlValues(cfg)
		if values["features.hooks"] == "false" || values["features.codex_hooks"] == "false" {
			off = append(off, cfg+": [features] hooks = false")
		}
		for _, file := range []string{cfg, filepath.Join(h.codex, "requirements.toml")} {
			if tomlValues(file)["allow_managed_hooks_only"] == "true" {
				off = append(off, file+": allow_managed_hooks_only = true")
			}
		}
	}
	return off
}

func jsonTrue(path, key string) bool {
	raw, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil {
		return false
	}
	return string(bytes.TrimSpace(m[key])) == "true"
}

// tomlValues reads simple `key = value` lines as "section.key" -> value. It
// covers the switches MEX checks, not TOML in general.
func tomlValues(path string) map[string]string {
	out := map[string]string{}
	f, err := os.Open(path)
	if err != nil {
		return out
	}
	defer f.Close()
	section := ""
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if i := strings.Index(line, "#"); i >= 0 {
			line = strings.TrimSpace(line[:i])
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = strings.Trim(line, "[] ")
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		key := strings.TrimSpace(k)
		if section != "" {
			key = section + "." + key
		}
		out[key] = strings.Trim(strings.TrimSpace(v), `"'`)
	}
	return out
}

// ---------------------------------------------------------------------------
// Whose hooks: does an agent have MEX hooks of its own?
// ---------------------------------------------------------------------------

// ownHookFiles are the user-level files an agent registers hooks in.
func (h home) ownHookFiles(agent string) []string {
	switch agent {
	case "claude-code":
		return []string{filepath.Join(h.user, ".claude", "settings.json")}
	case "codex":
		return []string{filepath.Join(h.codex, "hooks.json"), filepath.Join(h.codex, "config.toml")}
	case "cursor":
		return []string{filepath.Join(h.user, ".cursor", "hooks.json")}
	case "copilot":
		return []string{filepath.Join(h.user, ".copilot", "hooks.json")}
	}
	return nil
}

// hasOwnHooks reports whether an agent's own hook files call mex-hook.
func (h home) hasOwnHooks(agent string) bool {
	for _, f := range h.ownHookFiles(agent) {
		if raw, err := os.ReadFile(f); err == nil && bytes.Contains(raw, []byte("mex-hook")) {
			return true
		}
	}
	return false
}
