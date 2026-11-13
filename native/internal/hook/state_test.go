package hook

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/internal/adapter"
)

// fakeHome makes a person's home folder with MEX installed, and returns the
// environment that points the shim at it.
func fakeHome(t *testing.T, mexInstalled bool) (home, Env) {
	t.Helper()
	user := t.TempDir()
	if mexInstalled {
		if err := os.MkdirAll(filepath.Join(user, ".mex"), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	env := func(k string) string {
		if k == "HOME" || k == "USERPROFILE" {
			return user
		}
		return ""
	}
	return homeFrom(env), env
}

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestDetect(t *testing.T) {
	cases := map[string]string{
		`{"session_id":"s","hook_event_name":"PreToolUse","tool_name":"Read"}`:           "",
		`{"session_id":"s","turn_id":"t","hook_event_name":"PreToolUse"}`:                "codex",
		`{"conversation_id":"c","generation_id":"g","hook_event_name":"beforeReadFile"}`: "cursor",
		`{"cursor_version":"2.1","hook_event_name":"preToolUse"}`:                        "cursor",
		`{"timestamp":1,"cwd":"/x","toolName":"bash","toolArgs":"{}"}`:                   "copilot",
		`not json`: "",
	}
	for payload, want := range cases {
		if got := adapter.Detect([]byte(payload)); got != want {
			t.Errorf("Detect(%s) = %q, want %q", payload, got, want)
		}
	}
}

const cursorPayload = `{"conversation_id":"c","generation_id":"g","hook_event_name":"preToolUse","tool_name":"Read"}`

func TestCursorRunningClaudeHooksStaysSilent(t *testing.T) {
	for _, own := range []bool{false, true} {
		h, env := fakeHome(t, true)
		if own {
			write(t, filepath.Join(h.user, ".cursor", "hooks.json"), `{"hooks":{"preToolUse":[{"command":"/x/.mex/bin/mex-hook cursor preToolUse"}]}}`)
		}
		var out bytes.Buffer
		code := Run([]string{"claude-code", "PreToolUse"}, strings.NewReader(cursorPayload), &out, &bytes.Buffer{}, env)
		// No Cursor profile yet, so the borrowed hook says nothing either way.
		if code != 0 || out.Len() != 0 {
			t.Errorf("own=%v: code %d, output %q, want silent", own, code, out.String())
		}
	}
}

const codexPayload = `{"session_id":"s1","turn_id":"t","cwd":"/w","hook_event_name":"Stop","stop_hook_active":false}`

func TestCodexWithOwnHooksSilencesBorrowedHook(t *testing.T) {
	h, env := fakeHome(t, true)
	write(t, filepath.Join(h.user, ".codex", "hooks.json"), `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"mex-hook codex Stop"}]}]}}`)
	var out bytes.Buffer
	Run([]string{"claude-code", "Stop"}, strings.NewReader(codexPayload), &out, &bytes.Buffer{}, env)
	if out.Len() != 0 {
		t.Fatalf("output %q, want silent", out.String())
	}
	if _, n := h.lastBeat("claude-code"); n != 0 {
		t.Error("a silenced hook must not beat as claude-code")
	}
}

func TestCodexWithoutOwnHooksIsAnsweredAsCodex(t *testing.T) {
	h, env := fakeHome(t, true)
	var out bytes.Buffer
	Run([]string{"claude-code", "Stop"}, strings.NewReader(codexPayload), &out, &bytes.Buffer{}, env)
	if out.String() != "{}\n" {
		t.Fatalf("output %q", out.String())
	}
	if _, n := h.lastBeat("codex"); n != 1 {
		t.Error("the call should count as a Codex heartbeat")
	}
	if _, n := h.lastBeat("claude-code"); n != 0 {
		t.Error("the call must not count as a Claude Code heartbeat")
	}
}

func TestHeartbeat(t *testing.T) {
	h, env := fakeHome(t, true)
	payload := `{"session_id":"abc/../1","cwd":"/w","hook_event_name":"SessionStart","source":"startup"}`
	Run([]string{"claude-code", "SessionStart"}, strings.NewReader(payload), &bytes.Buffer{}, &bytes.Buffer{}, env)
	files, _ := os.ReadDir(h.heartbeatDir("claude-code"))
	if len(files) != 1 || strings.ContainsAny(files[0].Name(), `/\`) {
		t.Fatalf("heartbeat files = %v", files)
	}
	var hb heartbeatFile
	raw, _ := os.ReadFile(filepath.Join(h.heartbeatDir("claude-code"), files[0].Name()))
	if json.Unmarshal(raw, &hb) != nil || hb.SessionID != "abc/../1" || hb.Agent != "claude-code" {
		t.Fatalf("heartbeat body = %s", raw)
	}

	// A later call only moves the time forward.
	later := time.Now().Add(time.Hour)
	h.beat("claude-code", "abc/../1", "/w", false, later)
	last, n := h.lastBeat("claude-code")
	if n != 1 || last.Unix() != later.Unix() {
		t.Fatalf("last beat %v (%d files), want %v", last, n, later)
	}
}

func TestHeartbeatPrunesOldSessions(t *testing.T) {
	h, _ := fakeHome(t, true)
	now := time.Now()
	h.beat("codex", "old", "/w", false, now.Add(-8*24*time.Hour))
	h.beat("codex", "recent", "/w", false, now.Add(-time.Hour))
	h.beat("codex", "new", "/w", true, now)
	if _, n := h.lastBeat("codex"); n != 2 {
		t.Fatalf("%d heartbeats, want the old one pruned", n)
	}
}

func TestNoHeartbeatWithoutMex(t *testing.T) {
	h, env := fakeHome(t, false)
	Run([]string{"claude-code", "Stop"}, strings.NewReader(`{"session_id":"s","hook_event_name":"Stop"}`), &bytes.Buffer{}, &bytes.Buffer{}, env)
	if _, err := os.Stat(h.mex); !os.IsNotExist(err) {
		t.Fatal("the shim must never create ~/.mex")
	}
}

func TestHooksOff(t *testing.T) {
	h, _ := fakeHome(t, true)
	if off := h.hooksOff("claude-code", "linux"); len(off) != 0 {
		t.Fatalf("nothing set, got %v", off)
	}
	write(t, filepath.Join(h.user, ".claude", "settings.json"), `{"disableAllHooks": true}`)
	write(t, filepath.Join(h.user, ".codex", "config.toml"), "model = \"x\"\nallow_managed_hooks_only = true # policy\n\n[features]\nhooks = false\n")
	claude := h.hooksOff("claude-code", "linux")
	codex := h.hooksOff("codex", "linux")
	if len(claude) != 1 || !strings.HasSuffix(claude[0], "disableAllHooks") {
		t.Errorf("claude-code: %v", claude)
	}
	if len(codex) != 2 {
		t.Errorf("codex: %v", codex)
	}
	write(t, filepath.Join(h.user, ".codex", "config.toml"), "[features]\nhooks = true\n[other]\nallow_managed_hooks_only = true\n")
	if off := h.hooksOff("codex", "linux"); len(off) != 0 {
		t.Errorf("keys in other sections must not count: %v", off)
	}
}

func TestStatus(t *testing.T) {
	h, env := fakeHome(t, true)
	write(t, filepath.Join(h.user, ".codex", "config.toml"), "[features]\nhooks = false\n")
	Run([]string{"claude-code", "Stop"}, strings.NewReader(`{"session_id":"s","hook_event_name":"Stop"}`), &bytes.Buffer{}, &bytes.Buffer{}, env)

	var out bytes.Buffer
	if Run([]string{"--status"}, nil, &out, &bytes.Buffer{}, env) != 0 {
		t.Fatal("non-zero exit")
	}
	var report statusReport
	if err := json.Unmarshal(out.Bytes(), &report); err != nil {
		t.Fatalf("%s: %v", out.String(), err)
	}
	byAgent := map[string]agentStatus{}
	for _, a := range report.Agents {
		byAgent[a.Agent] = a
	}
	if c := byAgent["claude-code"]; c.LastHeartbeat == nil || c.Sessions != 1 || len(c.HooksOff) != 0 {
		t.Errorf("claude-code: %+v", c)
	}
	if c := byAgent["codex"]; c.LastHeartbeat != nil || len(c.HooksOff) != 1 {
		t.Errorf("codex: %+v", c)
	}
}
