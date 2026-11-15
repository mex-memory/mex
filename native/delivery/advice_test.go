package delivery

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
)

func TestAdviceEffectsNameObservedWorkWithoutRetainingText(t *testing.T) {
	f := newFixture(t)
	f.entry(spec{id: "mx_advice", kind: "pitfall", scope: "src/a.ts", oneLine: "Use the old API."})
	path := f.file("src/a.ts", "x")
	f.verdict("mx_advice", "held")
	mustHave(t, f.send(f.event(contract.PostToolBatch, read(path, "x"))), "old API")
	f.send(f.event(contract.PostToolBatch, edit(path, "private edit text")))
	f.send(f.event(contract.PostToolBatch, edit(path, "private edit text")))
	failed := edit(path, "bad")
	failed.Output.OK = false
	f.send(f.event(contract.PostToolBatch, failed))
	f.send(f.event(contract.PostToolBatch, shell("npm install --token=private-value", "private output", true)))
	f.verdict("mx_advice", "broken")
	correction := f.send(f.event(contract.PostToolBatch, read(path, "x")))
	for _, want := range []string{"Correction:", "When it became wrong is unknown", "edited src/a.ts", "npm install", "possible effects outside", "association only"} {
		mustHave(t, correction, want)
	}
	for _, secret := range []string{"private edit text", "private-value", "private output"} {
		if strings.Contains(correction, secret) {
			t.Fatal(correction)
		}
	}
	mustBeEmpty(t, f.send(f.event(contract.PostToolBatch, read(path, "x"))))
	db := fixtureHooksDB(t, f.dir)
	defer db.Close()
	var n int
	if err := db.QueryRow("SELECT count(*) FROM followups WHERE kind='edit'").Scan(&n); err != nil || n != 1 {
		t.Fatal(n, err)
	}
	var reserved int
	if err := db.QueryRow("SELECT reserved_tokens FROM epochs WHERE session_id=?", f.session).Scan(&reserved); err != nil || reserved == 0 {
		t.Fatal(reserved, err)
	}
}

func seedAdvice(t *testing.T, f *fixture, session, agent string, epoch int, receipt string) string {
	t.Helper()
	f.file(".git/HEAD", "ref: refs/heads/work\n")
	f.file(".git/refs/heads/work", strings.Repeat("a", 40)+"\n")
	id := "advice." + strings.Repeat("b", 24)
	a := record.AdviceAdvisory{Version: 1, ID: id, Checkout: f.root, Branch: "refs/heads/work", Entry: "mx_advice", Text: "Correction: mx_advice no longer holds. Wrong all along (person-confirmed): every recorded use is suspect.", Label: "person-confirmed", Receipts: []record.AdviceReceipt{{ID: receipt, Session: session, Agent: agent, Epoch: epoch}}}
	db, err := sql.Open("sqlite", filepath.Join(f.dir, "record.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec("CREATE TABLE settings(scope TEXT,key TEXT,value TEXT,PRIMARY KEY(scope,key)); PRAGMA user_version=4"); err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(a)
	if _, err = db.Exec("INSERT INTO settings VALUES(?,?,?)", f.project, id, string(data)); err != nil {
		t.Fatal(err)
	}
	if err = os.MkdirAll(filepath.Join(f.dir, "judge-advice"), 0700); err != nil {
		t.Fatal(err)
	}
	data, _ = json.Marshal([]string{id})
	if err = os.WriteFile(filepath.Join(f.dir, "judge-advice", place.ShortHash(f.root+"\x00refs/heads/work")+".json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestAdvisoryCorrectsExactCurrentEpochWithoutAnOrdinaryMoment(t *testing.T) {
	for _, mode := range []string{"current", "wrong-session", "wrong-agent", "wrong-epoch", "wrong-receipt", "wrong-branch", "ended", "codex-stop"} {
		t.Run(mode, func(t *testing.T) {
			f := newFixture(t)
			if mode == "codex-stop" {
				f.agent = "codex"
			}
			h, err := record.OpenHooks(record.Location{Hooks: filepath.Join(f.dir, "hooks.db")})
			if err != nil {
				t.Fatal(err)
			}
			req := baseRequest(f.event(contract.SessionStart), f.env(), f.project, f.root)
			req.Candidates = []record.DeliveryCandidate{{EntryID: "mx_advice", Moment: "read", Form: "full", Tokens: 2000, Action: "given", Reserved: true}}
			res, err := h.CheckAndMark(req)
			if err != nil {
				t.Fatal(err)
			}
			session, agent, epoch, receipt := f.session, f.agentID, res.Epoch.Number, res.Receipts[0].ID
			if mode == "wrong-session" {
				session = "other"
			}
			if mode == "wrong-agent" {
				agent = "child"
			}
			if mode == "wrong-epoch" {
				epoch++
			}
			if mode == "wrong-receipt" {
				receipt = "other"
			}
			seedAdvice(t, f, session, agent, epoch, receipt)
			if mode == "wrong-branch" {
				f.file(".git/HEAD", "ref: refs/heads/other\n")
				f.file(".git/refs/heads/other", strings.Repeat("a", 40)+"\n")
			}
			if mode == "ended" {
				req.Candidates = nil
				req.EndEpoch = true
				if _, err = h.CheckAndMark(req); err != nil {
					t.Fatal(err)
				}
			}
			h.Close()
			out := f.send(f.event(contract.Stop))
			if mode == "codex-stop" {
				mustBeEmpty(t, out)
				prompt := f.event(contract.Prompt)
				prompt.Prompt = &contract.PromptIn{Text: "continue", Typed: true}
				mustHave(t, f.send(prompt), "Wrong all along")
			} else if mode == "current" {
				mustHave(t, out, "Wrong all along")
				mustBeEmpty(t, f.send(f.event(contract.Stop)))
			} else {
				mustBeEmpty(t, out)
			}
		})
	}
}
