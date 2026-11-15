package hook

import (
	"database/sql"
	"encoding/json"
	"io"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/internal/contract"
	localrecord "github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
)

func seedAdviceNotice(t *testing.T, h home, checkout, agent string) string {
	t.Helper()
	seedJudgeNotice(t, h, checkout, agent)
	at, _ := judgeGitPosition(checkout)
	id := "advice." + strings.Repeat("c", 24)
	value := localrecord.AdviceAdvisory{Version: 1, ID: id, Checkout: checkout, Branch: at.Branch, Entry: "mx_advice", Text: "Correction: this entry no longer holds.", Receipts: []localrecord.AdviceReceipt{{ID: "prior", Session: "s1", Epoch: 0}}}
	data, _ := json.Marshal(value)
	db, err := sql.Open("sqlite", filepath.Join(h.mex, "record.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec("INSERT INTO settings(scope,key,value) VALUES(?,?,?)", projectID, id, string(data)); err != nil {
		t.Fatal(err)
	}
	ids, _ := json.Marshal([]string{id})
	write(t, filepath.Join(h.mex, "judge-advice", place.ShortHash(checkout+"\x00"+at.Branch)+".json"), string(ids))
	return id
}
func TestAdviceNoticeOnlyNextNewSessionOnSameBranch(t *testing.T) {
	h, _ := fakeHome(t, true)
	checkout := judgeRepo(t)
	id := seedAdviceNotice(t, h, checkout, "claude-code")
	ev := contract.Event{Kind: contract.SessionStart, Agent: "claude-code", ProjectID: projectID, Checkout: checkout, SessionID: "next"}
	if ids, line := adviceNotice(ev, h, h.mex); len(ids) != 1 || ids[0] != id || !strings.Contains(line, "mex report") {
		t.Fatal(ids, line)
	}
	for _, mode := range []string{"same-session", "resume", "compact", "child", "other-checkout", "other-branch"} {
		other := ev
		switch mode {
		case "same-session":
			other.SessionID = "s1"
		case "resume":
			other.Source = "resume"
		case "compact":
			other.Source = "compact"
		case "child":
			other.AgentID = "child"
		case "other-checkout":
			other.Checkout = judgeRepo(t)
		case "other-branch":
			write(t, filepath.Join(checkout, ".git/HEAD"), "ref: refs/heads/other\n")
		}
		if ids, _ := adviceNotice(other, h, h.mex); len(ids) > 0 {
			t.Fatal(mode, ids)
		}
	}
}
func TestAdviceReceiptFollowsCompleteVisibleOutput(t *testing.T) {
	for _, agent := range []string{"claude-code", "codex"} {
		t.Run(agent, func(t *testing.T) {
			h, env := fakeHome(t, true)
			checkout := judgeRepo(t)
			register(t, h, checkout, projectID, "on", "")
			id := seedAdviceNotice(t, h, checkout, agent)
			payload, _ := json.Marshal(map[string]any{"session_id": "next", "cwd": checkout, "source": "startup"})
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
			Run([]string{agent, "SessionStart"}, strings.NewReader(string(payload)), failedJudgeOutput{}, io.Discard, env)
			if shown() {
				t.Fatal("failed output marked advisory shown")
			}
			_, out := run(t, []string{agent, "SessionStart"}, strings.NewReader(string(payload)), env)
			if !strings.Contains(out, "local advisories") || !shown() {
				t.Fatal(out, shown())
			}
			_, again := run(t, []string{agent, "SessionStart"}, strings.NewReader(string(payload)), env)
			if strings.Contains(again, "local advisories") {
				t.Fatal(again)
			}
		})
	}
}
