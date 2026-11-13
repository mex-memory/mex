package hook

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	localrecord "github.com/mex-memory/mex/native/record"
)

func TestHookTelemetryDoesNotWaitForALockedDatabase(t *testing.T) {
	_, env, location := telemetryHome(t)
	db, err := sql.Open("sqlite", location.Hooks)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err := db.Exec("PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE"); err != nil {
		t.Fatal(err)
	}
	defer db.Exec("ROLLBACK")
	var out bytes.Buffer
	start := time.Now()
	Run([]string{"claude-code", "PreToolUse"}, strings.NewReader(`{"session_id":"s","tool_name":"Read"}`), &out, &bytes.Buffer{}, env)
	if elapsed := time.Since(start); elapsed > 100*time.Millisecond {
		t.Fatalf("usage capture waited for the locked record: %s", elapsed)
	}
	if !json.Valid(out.Bytes()) {
		t.Fatalf("hook did not fail open: %q", out.String())
	}
}

func telemetryHome(t *testing.T) (home, Env, localrecord.Location) {
	t.Helper()
	h, env := fakeHome(t, true)
	location, err := localrecord.ResolveLocation(localrecord.LocationOptions{Home: h.mex})
	if err != nil {
		t.Fatal(err)
	}
	return h, env, location
}

func TestHooksAccumulateOnlyLocalCounters(t *testing.T) {
	h, env, location := telemetryHome(t)
	for _, event := range []string{"SessionStart", "PreToolUse"} {
		var out bytes.Buffer
		payload := `{"session_id":"PRIVATE_SESSION","cwd":"/PRIVATE_PATH","hook_event_name":"` + event + `","tool_name":"Read","tool_input":{"file_path":"/PRIVATE_FILE"}}`
		if Run([]string{"claude-code", event}, strings.NewReader(payload), &out, &bytes.Buffer{}, env) != 0 || !json.Valid(out.Bytes()) {
			t.Fatalf("hook stopped the agent: %s", out.String())
		}
	}
	db, err := sql.Open("sqlite", location.Hooks)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	rows, err := db.Query("SELECT name,value FROM counters_go")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	values := map[string]int{}
	for rows.Next() {
		var name string
		var value int
		if err := rows.Scan(&name, &value); err != nil {
			t.Fatal(err)
		}
		values[name] = value
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if values["agent:claude-code:sessions"] != 1 || values["agent:claude-code:hook.calls"] != 2 {
		t.Fatalf("counts: %v", values)
	}
	for name := range values {
		if strings.Contains(name, "PRIVATE") {
			t.Fatalf("private value entered counters: %s", name)
		}
	}
	if _, err := os.Stat(filepath.Join(h.mex, "telemetry-id")); !os.IsNotExist(err) {
		t.Fatal("hook created an analytics identity")
	}
}

func TestHookTelemetryHonorsSwitchesAndCI(t *testing.T) {
	for _, key := range []string{"DO_NOT_TRACK", "MEX_TELEMETRY", "MEX_OFFLINE", "CI", "GITHUB_ACTIONS"} {
		t.Run(key, func(t *testing.T) {
			_, base, location := telemetryHome(t)
			env := func(name string) string {
				if name == key {
					if key == "MEX_TELEMETRY" {
						return "0"
					}
					return "1"
				}
				return base(name)
			}
			var out bytes.Buffer
			Run([]string{"claude-code", "SessionStart"}, strings.NewReader(`{"session_id":"s","cwd":"/x"}`), &out, &bytes.Buffer{}, env)
			if !json.Valid(out.Bytes()) {
				t.Fatalf("invalid hook output: %q", out.String())
			}
			if _, err := os.Stat(location.Hooks); !os.IsNotExist(err) {
				t.Fatal("disabled hook created counters")
			}
		})
	}
}

func TestHookTelemetryKeepsStoredOptOutAndFailsOpen(t *testing.T) {
	for _, contents := range []string{`{"telemetry":"off"}`, `{"telemetry":null}`, `broken`} {
		t.Run(contents, func(t *testing.T) {
			h, env, location := telemetryHome(t)
			write(t, filepath.Join(h.mex, "config.json"), contents)
			var out bytes.Buffer
			Run([]string{"claude-code", "SessionStart"}, strings.NewReader(`{"session_id":"s","cwd":"/x"}`), &out, &bytes.Buffer{}, env)
			if !json.Valid(out.Bytes()) {
				t.Fatal("hook did not fail open")
			}
			if _, err := os.Stat(location.Hooks); !os.IsNotExist(err) {
				t.Fatal("opt-out created counters")
			}
		})
	}
	h, env, location := telemetryHome(t)
	write(t, location.Hooks, "not a SQLite file")
	var out bytes.Buffer
	Run([]string{"claude-code", "SessionStart"}, strings.NewReader(`{"session_id":"s","cwd":"/x"}`), &out, &bytes.Buffer{}, env)
	if !json.Valid(out.Bytes()) {
		t.Fatal("unreadable counters stopped the hook")
	}
	if _, err := os.Stat(filepath.Join(h.mex, "telemetry-id")); !os.IsNotExist(err) {
		t.Fatal("hook created identity")
	}
}

func TestMexHomeUsesTheSameBaseRuleAsNode(t *testing.T) {
	base := t.TempDir()
	h := homeFrom(func(key string) string {
		if key == "MEX_HOME" {
			return base
		}
		return ""
	})
	if h.mex != filepath.Join(base, ".mex") {
		t.Fatalf("MEX_HOME is a base directory, got %s", h.mex)
	}
}
