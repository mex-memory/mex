package capture

import (
	"path/filepath"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record"
)

const testProject = "g-0123456789abcdef01234567"

type session struct {
	t   *testing.T
	env Env
	id  string
}

func (s session) ev(kind contract.Kind, tool *contract.Tool) contract.Event {
	return contract.Event{Agent: "claude-code", Kind: kind, SessionID: s.id, ProjectID: testProject, Checkout: "/r", Tool: tool}
}

func (s session) fail(command string, code int) {
	s.t.Helper()
	Hook(s.ev(contract.PostToolFailure, &contract.Tool{Name: contract.ToolShell, Input: contract.ToolInput{Command: command}, Output: &contract.ToolOutput{ExitCode: &code}}), s.env)
}

func (s session) pass(command string) {
	s.t.Helper()
	Hook(s.ev(contract.PostTool, &contract.Tool{Name: contract.ToolShell, Input: contract.ToolInput{Command: command}, Output: &contract.ToolOutput{OK: true}}), s.env)
}

func (s session) edit(path string) {
	s.t.Helper()
	Hook(s.ev(contract.PostTool, &contract.Tool{Name: contract.ToolEdit, Input: contract.ToolInput{Path: path}, Output: &contract.ToolOutput{OK: true}}), s.env)
}

func pairsOf(t *testing.T, env Env) map[string]Pair {
	t.Helper()
	pairs, err := ReadPairs(env.RecordDirectory, testProject)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]Pair{}
	for _, p := range pairs {
		out[p.Failed+" -> "+p.Passed] = p
	}
	return out
}

func TestStrictPairsAcrossSessions(t *testing.T) {
	env := Env{RecordDirectory: t.TempDir(), Now: time.Date(2026, 11, 15, 12, 0, 0, 0, time.UTC)}
	a := session{t, env, "a"}
	a.fail("npm test", 1)
	a.pass("npm ci && npm test")
	// An edit in between: the pass proves nothing.
	a.fail("npm run build", 1)
	a.edit("/r/src/a.ts")
	a.pass("npm run build")
	// A plain rerun: flaky.
	a.fail("go test ./...", 1)
	a.pass("go test ./...")
	// A narrower run is never kept.
	a.fail("pytest", 1)
	a.pass("pytest -k login")
	got := pairsOf(t, env)
	if len(got) != 2 || got["npm test -> npm ci && npm test"].Kind != "candidate" || got["go test ./... -> go test ./..."].Kind != "flaky" {
		t.Fatalf("%+v", got)
	}

	// The same failure again in the same session isn't a return.
	a.fail("npm test", 1)
	if p := pairsOf(t, env)["npm test -> npm ci && npm test"]; p.Kind != "candidate" {
		t.Fatalf("%+v", p)
	}
	// A different exit code isn't the same failure.
	b := session{t, env, "b"}
	b.fail("npm test", 2)
	if p := pairsOf(t, env)["npm test -> npm ci && npm test"]; p.Kind != "candidate" {
		t.Fatalf("%+v", p)
	}
	// It returns in a later session where MEX didn't deliver the fix: a hint.
	b.fail("npm test", 1)
	p := pairsOf(t, env)["npm test -> npm ci && npm test"]
	if p.Kind != "hint" || p.Returned != "b" || p.ID != PairID("npm test", 1, "npm ci && npm test") {
		t.Fatalf("%+v", p)
	}
	// Flaky reruns never become hints.
	b.fail("go test ./...", 1)
	if p := pairsOf(t, env)["go test ./... -> go test ./..."]; p.Kind != "flaky" {
		t.Fatalf("%+v", p)
	}
}

func TestReturnAfterDeliveryIsNotAHint(t *testing.T) {
	env := Env{RecordDirectory: t.TempDir()}
	a := session{t, env, "a"}
	a.fail("cargo build", 101)
	a.pass("cargo build --locked")
	id := PairID("cargo build", 101, "cargo build --locked")
	// MEX gave the fix in session b, and the failure came back anyway.
	h, err := record.OpenHooks(record.Location{Directory: env.RecordDirectory, Hooks: filepath.Join(env.RecordDirectory, "hooks.db")})
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	_, err = h.CheckAndMark(record.DeliveryRequest{Session: record.Session{SessionID: "b", Agent: "claude-code", ProjectID: testProject, Checkout: "/r"}, Reason: "startup", Now: now,
		Candidates: []record.DeliveryCandidate{{EntryID: id, Moment: "failure", Form: "one-line", Action: "given", Tokens: 10, ContentHash: "x"}}})
	h.Close()
	if err != nil {
		t.Fatal(err)
	}
	b := session{t, env, "b"}
	b.fail("cargo build", 101)
	if p := pairsOf(t, env)["cargo build -> cargo build --locked"]; p.Kind != "candidate" {
		t.Fatalf("%+v", p)
	}
	// A third session without delivery promotes it.
	c := session{t, env, "c"}
	c.fail("cargo build", 101)
	if p := pairsOf(t, env)["cargo build -> cargo build --locked"]; p.Kind != "hint" || p.Returned != "c" {
		t.Fatalf("%+v", p)
	}
}

func TestSubagentCommandsDontPair(t *testing.T) {
	env := Env{RecordDirectory: t.TempDir()}
	a := session{t, env, "a"}
	one := 1
	ev := a.ev(contract.PostToolFailure, &contract.Tool{Name: contract.ToolShell, Input: contract.ToolInput{Command: "npm test"}, Output: &contract.ToolOutput{ExitCode: &one}})
	ev.AgentID = "sub"
	Hook(ev, env)
	a.pass("npm test")
	if got := pairsOf(t, env); len(got) != 0 {
		t.Fatalf("%+v", got)
	}
}
