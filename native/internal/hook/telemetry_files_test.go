package hook

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

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
			// Prepare the real schema outside hook deadlines: this test checks
			// alias refusal, not how quickly a cold schema can be initialized.
			db, err := sql.Open("sqlite", location.Hooks)
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			db.SetMaxOpenConns(1)
			schema, err := os.ReadFile(filepath.Join("..", "..", "record", "schema", "hooks", "0001_init.sql"))
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			_, err = db.ExecContext(ctx, "PRAGMA journal_mode=WAL; BEGIN IMMEDIATE;\n"+string(schema)+fmt.Sprintf("\nPRAGMA user_version=%d; COMMIT;", localrecord.SchemaVersion))
			cancel()
			if err != nil {
				t.Fatal(err)
			}
			// This connection keeps the initialized WAL/SHM present for linking.
			outside := filepath.Join(t.TempDir(), "outside")
			if err := os.Link(location.Hooks+suffix, outside); err != nil {
				t.Fatal(err)
			}
			var out bytes.Buffer
			Run([]string{"claude-code", "PreToolUse"}, strings.NewReader(`{"session_id":"fixture","tool_name":"Read"}`), &out, &bytes.Buffer{}, env)
			if !json.Valid(out.Bytes()) {
				t.Fatalf("hook did not fail open: %q", out.String())
			}
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
