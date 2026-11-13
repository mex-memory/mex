package hook

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	localrecord "github.com/mex-memory/mex/native/record"
)

func TestTelemetryFileSafety(t *testing.T) {
	root := t.TempDir()
	regular := filepath.Join(root, "regular")
	if err := os.WriteFile(regular, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if !safeTelemetryFile(regular) || !safeTelemetryFile(filepath.Join(root, "missing")) {
		t.Fatal("regular or missing file rejected")
	}
	if safeTelemetryFile(root) {
		t.Fatal("directory accepted")
	}
	hardlink := filepath.Join(root, "hardlink")
	if err := os.Link(regular, hardlink); err != nil {
		t.Fatal(err)
	}
	if safeTelemetryFile(regular) || safeTelemetryFile(hardlink) {
		t.Fatal("hard-linked file accepted")
	}
	if err := os.Remove(hardlink); err != nil {
		t.Fatal(err)
	}
	if !safeTelemetryFile(regular) {
		t.Fatal("single-link file rejected after unlink")
	}
	for _, target := range []string{regular, filepath.Join(root, "missing-target")} {
		link := filepath.Join(t.TempDir(), "symlink")
		if err := os.Symlink(target, link); err != nil {
			t.Fatal(err)
		}
		if safeTelemetryFile(link) {
			t.Fatal("symbolic link accepted")
		}
	}
}

func TestHookTelemetryRefusesHardLinkedDatabaseFiles(t *testing.T) {
	for _, suffix := range []string{"", "-wal", "-shm"} {
		t.Run("hooks.db"+suffix, func(t *testing.T) {
			_, env, location := telemetryHome(t)
			// Keep the initialized WAL/SHM open, avoiding a cold migration in the
			// hook's deliberately short measurement budget.
			hooks, err := localrecord.OpenHooks(location)
			if err != nil {
				t.Fatal(err)
			}
			defer hooks.Close()
			outside := filepath.Join(t.TempDir(), "outside")
			if err := os.Link(location.Hooks+suffix, outside); err != nil {
				t.Fatal(err)
			}
			var out bytes.Buffer
			Run([]string{"claude-code", "PreToolUse"}, strings.NewReader(`{"session_id":"fixture","tool_name":"Read"}`), &out, &bytes.Buffer{}, env)
			if !json.Valid(out.Bytes()) {
				t.Fatalf("hook did not fail open: %q", out.String())
			}
			db, err := sql.Open("sqlite", location.Hooks)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			var rows int
			if err := db.QueryRow("SELECT count(*) FROM counters_go").Scan(&rows); err != nil {
				t.Fatal(err)
			}
			if rows != 0 {
				t.Fatalf("usage capture wrote through a hard-linked database file: %d rows", rows)
			}
		})
	}
}
