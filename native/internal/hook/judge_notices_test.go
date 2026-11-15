package hook

import (
	"database/sql"
	"encoding/json"
	"io"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/internal/contract"
	localrecord "github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
)

func seedJudgeNotice(t *testing.T, h home, checkout, agent string) (string, contract.Event) {
	t.Helper()
	ev := contract.Event{ProjectID: projectID, Checkout: checkout, Agent: agent, SessionID: "s1", Kind: contract.Prompt}
	key := place.ShortHash(checkout + "\x00" + agent + "\x00s1")
	id := "judge.fix." + strings.Repeat("a", 24) + ".preview"
	at, _ := judgeGitPosition(checkout)
	message, _ := json.Marshal(map[string]any{"version": 1, "position": at, "text": "MEX proposes a knowledge update.\n-old claim\n+new claim\n"})
	db, err := sql.Open("sqlite", filepath.Join(h.mex, "record.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec(`CREATE TABLE IF NOT EXISTS settings(scope TEXT,key TEXT,value TEXT);
CREATE TABLE IF NOT EXISTS notices(id TEXT PRIMARY KEY,kind TEXT,text TEXT,created_at TEXT); PRAGMA user_version=4;`); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("INSERT INTO notices VALUES(?,?,?,'now')", id, "judge-preview."+key, string(message)); err != nil {
		t.Fatal(err)
	}
	ids, _ := json.Marshal([]string{id})
	write(t, filepath.Join(h.mex, "judge-notices", key+".json"), string(ids))
	hooks, err := localrecord.OpenHooks(hooksLocation(h, h.mex))
	if err != nil {
		t.Fatal(err)
	}
	defer hooks.Close()
	if err = hooks.PutSession(localrecord.Session{SessionID: "s1", Agent: agent, ProjectID: projectID, Checkout: checkout, StartedAt: "now", LastSeenAt: "now"}); err != nil {
		t.Fatal(err)
	}
	return id, ev
}

func TestJudgeNoticeOnlyGoesToItsSessionAndBranch(t *testing.T) {
	h, _ := fakeHome(t, true)
	checkout := judgeRepo(t)
	id, ev := seedJudgeNotice(t, h, checkout, "claude-code")
	if found, text := judgeNotice(ev, h, h.mex); found != id || !strings.Contains(text, "-old claim") {
		t.Fatalf("preview: %s %s", found, text)
	}
	for _, mode := range []string{"session", "agent", "child", "checkout", "branch"} {
		other := ev
		switch mode {
		case "session":
			other.SessionID = "s2"
		case "agent":
			other.Agent = "codex"
		case "child":
			other.AgentID = "child"
		case "checkout":
			other.Checkout = judgeRepo(t)
		case "branch":
			write(t, filepath.Join(checkout, ".git", "HEAD"), "ref: refs/heads/other\n")
		}
		if found, _ := judgeNotice(other, h, h.mex); found != "" {
			t.Fatalf("%s received the preview", mode)
		}
	}
}

type failedJudgeOutput struct{}

func (failedJudgeOutput) Write([]byte) (int, error) { return 0, io.ErrClosedPipe }

func TestJudgePreviewReceiptFollowsCompleteVisibleOutput(t *testing.T) {
	for _, agent := range []string{"claude-code", "codex"} {
		t.Run(agent, func(t *testing.T) {
			h, env := fakeHome(t, true)
			checkout := judgeRepo(t)
			register(t, h, checkout, projectID, "on", "")
			id, _ := seedJudgeNotice(t, h, checkout, agent)
			payload, _ := json.Marshal(map[string]any{"session_id": "s1", "cwd": checkout, "prompt": "hello"})
			shown := func() bool {
				hooks, err := localrecord.OpenHooks(hooksLocation(h, h.mex))
				if err != nil {
					t.Fatal(err)
				}
				defer hooks.Close()
				seen, err := hooks.NoticeShown(id)
				if err != nil {
					t.Fatal(err)
				}
				return seen
			}
			Run([]string{agent, "UserPromptSubmit"}, strings.NewReader(string(payload)), failedJudgeOutput{}, io.Discard, env)
			if shown() {
				t.Fatal("failed stdout write authorized a tracked update")
			}
			_, out := run(t, []string{agent, "UserPromptSubmit"}, strings.NewReader(string(payload)), env)
			var reply map[string]any
			if json.Unmarshal([]byte(out), &reply) != nil || !strings.Contains(out, "old claim") || !shown() {
				t.Fatalf("not displayed and receipted: %s", out)
			}
			if reply["decision"] != nil {
				t.Fatal("preview consumed or blocked the person's prompt")
			}
			_, again := run(t, []string{agent, "UserPromptSubmit"}, strings.NewReader(string(payload)), env)
			if strings.Contains(again, "old claim") {
				t.Fatal("preview was repeated")
			}
		})
	}
}

func TestJudgeReceiptCannotUseAnotherHostsCollidingSession(t *testing.T) {
	h, _ := fakeHome(t, true)
	id, ev := seedJudgeNotice(t, h, judgeRepo(t), "claude-code")
	ev.Agent = "codex"
	markJudgeNotice(ev, h, h.mex, id, time.Now())
	hooks, err := localrecord.OpenHooks(hooksLocation(h, h.mex))
	if err != nil {
		t.Fatal(err)
	}
	defer hooks.Close()
	if shown, err := hooks.NoticeShown(id); err != nil || shown {
		t.Fatalf("colliding session marked the preview: %v %v", shown, err)
	}
}
