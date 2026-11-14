package hook

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestOrphanCleanupOnlyForDefinitelyMissingCLI(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("Node is required for the standalone cleanup bundle")
	}
	for _, sourceExists := range []bool{true, false} {
		for _, sessionStart := range []bool{true, false} {
			t.Run(stringBool(sourceExists)+"-"+stringBool(sessionStart), func(t *testing.T) {
				root := t.TempDir()
				h := home{user: root, mex: filepath.Join(root, ".mex")}
				if err := os.MkdirAll(filepath.Join(h.mex, "bin"), 0o700); err != nil {
					t.Fatal(err)
				}
				entry := filepath.Join(root, "cli.js")
				if sourceExists {
					if err := os.WriteFile(entry, []byte("// present"), 0o600); err != nil {
						t.Fatal(err)
					}
				}
				marker := filepath.Join(h.mex, "cleanup-ran")
				encodedMarker, _ := json.Marshal(marker)
				fallback := "require('node:fs').writeFileSync(" + string(encodedMarker) + ", 'yes');"
				if err := os.WriteFile(filepath.Join(h.mex, "bin", "mex-hook.cjs"), []byte(fallback), 0o600); err != nil {
					t.Fatal(err)
				}
				data, _ := json.Marshal(launcher{Version: 1, Node: node, Entry: entry})
				if err := os.WriteFile(filepath.Join(h.mex, "bin", "launcher.json"), data, 0o600); err != nil {
					t.Fatal(err)
				}
				if h.orphaned(sessionStart) == sourceExists {
					t.Fatal("only an absent CLI is an orphan")
				}
				if exists(marker) != (!sourceExists && sessionStart) {
					t.Fatal("cleanup runs only at session start after the CLI is removed")
				}
			})
		}
	}
}

func stringBool(value bool) string {
	if value {
		return "true"
	}
	return "false"
}

func TestLegacyProjectHookIsSilent(t *testing.T) {
	var stdout, stderr bytes.Buffer
	getenv := func(string) string { return "" }
	if code := Run([]string{"claude-code", "SessionStart", "--mex-managed"}, bytes.NewBufferString(`{"session_id":"fixture"}`), &stdout, &stderr, getenv); code != 0 || stdout.Len() != 0 || stderr.Len() != 0 {
		t.Fatal("legacy registrations must be inert and fail open")
	}
}

func TestClaudeConfigOverride(t *testing.T) {
	root := t.TempDir()
	h := homeFrom(func(key string) string {
		if key == "HOME" || key == "USERPROFILE" {
			return root
		}
		if key == "CLAUDE_CONFIG_DIR" {
			return filepath.Join(root, "claude-profile")
		}
		return ""
	})
	if h.ownHookFiles("claude-code")[0] != filepath.Join(root, "claude-profile", "settings.json") {
		t.Fatal("the shim must inspect the same settings path as the installer")
	}
}

func TestOversizedLauncherFailsOpen(t *testing.T) {
	root := t.TempDir()
	h := home{user: root, mex: filepath.Join(root, ".mex")}
	if err := os.MkdirAll(filepath.Join(h.mex, "bin"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(h.mex, "bin", "launcher.json"), []byte(strings.Repeat(" ", 4097)), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, ok := h.launcher(); ok || h.orphaned(true) {
		t.Fatal("oversized metadata must not authorize cleanup")
	}
}
