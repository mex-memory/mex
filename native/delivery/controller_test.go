package delivery

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/internal/adapter"
	_ "github.com/mex-memory/mex/native/internal/adapter/claude"
	_ "github.com/mex-memory/mex/native/internal/adapter/codex"
	"github.com/mex-memory/mex/native/internal/contract"
)

func TestLifecyclePayloads(t *testing.T) {
	for _, agent := range []string{"claude-code", "codex"} {
		t.Run(agent, func(t *testing.T) {
			dir := t.TempDir()
			db := fixtureHooksDB(t, dir)
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
			profile, _ := adapter.Lookup(agent)
			for _, tc := range []struct {
				event, source, child string
				epoch, budget        int
			}{
				{"SessionStart", "startup", "", 0, 3000}, {"SessionStart", "resume", "", 0, 3000},
				{"PostCompact", "", "", 1, 3000}, {"SessionStart", "compact", "", 1, 3000},
				{"SessionStart", "compact", "", 2, 3000}, {"PostCompact", "", "", 2, 3000},
				{"SessionStart", "clear", "", 3, 3000}, {"SessionStart", "fork", "", 4, 3000},
				{"SubagentStart", "", "child", 0, 600}, {"SubagentStart", "", "child", 0, 600},
				{"SessionStart", "resume", "", 4, 3000},
			} {
				raw, _ := json.Marshal(map[string]any{"session_id": "lifecycle", "source": tc.source, "agent_id": tc.child, "model": "example[1m]", "cwd": "/repo"})
				ev, err := profile.Parse(tc.event, raw)
				if err != nil {
					t.Fatal(err)
				}
				ev.ProjectID = "project"
				ev.Checkout = "/repo"
				reply, err := Handle(ev, Environment{RecordDirectory: dir, Now: time.Now()})
				if err != nil || !reply.Empty() {
					t.Fatal(reply, err)
				}
				db, err := sql.Open("sqlite", filepath.Join(dir, "hooks.db"))
				if err != nil {
					t.Fatal(err)
				}
				var epoch, budget int
				err = db.QueryRow(`SELECT epoch,budget FROM epochs WHERE session_id='lifecycle' AND agent_id=? ORDER BY epoch DESC LIMIT 1`, tc.child).Scan(&epoch, &budget)
				db.Close()
				if err != nil || epoch != tc.epoch || budget != tc.budget {
					t.Fatalf("%+v got epoch=%d budget=%d %v", tc, epoch, budget, err)
				}
			}
		})
	}
}
func TestNoMomentTouchesNoStorage(t *testing.T) {
	root := filepath.Join(t.TempDir(), "absent")
	for _, kind := range contract.Kinds {
		if kind == contract.SessionStart || kind == contract.PostCompact || kind == contract.SubagentStart {
			continue
		}
		reply, err := Handle(contract.Event{Kind: kind, SessionID: "s", ProjectID: "p", Checkout: "/repo"}, Environment{RecordDirectory: root})
		if err != nil || !reply.Empty() {
			t.Fatal(kind, reply, err)
		}
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatal("no-op created storage")
	}
}
func TestEpochBudgets(t *testing.T) {
	for _, tc := range []struct {
		model  string
		sub    bool
		budget int
	}{{"", false, 2000}, {"unknown", false, 2000}, {"example[1m]", false, 3000}, {"example[1m]", true, 600}} {
		if got := EpochBudget(tc.model, tc.sub); got != tc.budget {
			t.Fatal(tc, got)
		}
	}
}

func TestLifecycleRefusesRedirectedDatabase(t *testing.T) {
	for _, kind := range []string{"hardlink", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			dir, outside := t.TempDir(), filepath.Join(t.TempDir(), "outside.db")
			if err := os.WriteFile(outside, []byte("original bytes"), 0600); err != nil {
				t.Fatal(err)
			}
			var err error
			if kind == "hardlink" {
				err = os.Link(outside, filepath.Join(dir, "hooks.db"))
			} else {
				err = os.Symlink(outside, filepath.Join(dir, "hooks.db"))
			}
			if err != nil {
				t.Skip("link unavailable")
			}
			r, err := Handle(contract.Event{Kind: contract.SessionStart, SessionID: "s", Agent: "test", ProjectID: "p", Checkout: "/repo"}, Environment{RecordDirectory: dir})
			if err == nil || !r.Empty() {
				t.Fatal("redirected database accepted", r, err)
			}
			b, err := os.ReadFile(outside)
			if err != nil || string(b) != "original bytes" {
				t.Fatal("outside database changed", err)
			}
		})
	}
}
