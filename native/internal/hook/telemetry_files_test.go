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
