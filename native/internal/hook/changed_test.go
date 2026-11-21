package hook

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/delivery"
	"github.com/mex-memory/mex/native/index/shift"
	"github.com/mex-memory/mex/native/internal/contract"
)

// Edits are kept per session and read back only after a shell command.
func TestChangedLinesPerSession(t *testing.T) {
	dir := t.TempDir()
	ev := contract.Event{Agent: "claude-code", SessionID: "s1", Kind: contract.PostTool}
	noteChanged(ev, dir, []fileEdit{{path: "/repo/a.ts", ranges: []shift.Range{{From: 3, To: 4}}, placed: true}})
	noteChanged(ev, dir, []fileEdit{{path: "/repo/b.ts", placed: false}})

	pre := ev
	pre.Kind = contract.PostTool
	pre.Tool = &contract.Tool{Name: contract.ToolShell, Input: contract.ToolInput{Command: "npm test"}}
	got := sessionChanged(pre, dir).Lines
	if !reflect.DeepEqual(got["/repo/a.ts"], []delivery.LineSpan{{From: 3, To: 4}}) || len(got["/repo/b.ts"]) != 1 {
		t.Fatalf("read back %v", got)
	}
	other := pre
	other.SessionID = "s2"
	if got := sessionChanged(other, dir).Lines; len(got) != 0 {
		t.Fatalf("another session saw %v", got)
	}
	read := pre
	read.Tool = &contract.Tool{Name: contract.ToolRead}
	if got := sessionChanged(read, dir).Lines; got != nil {
		t.Fatal("read state before a non-shell tool")
	}
}

func TestShellChangedUpdatesLegacySession(t *testing.T) {
	file := filepath.Join(t.TempDir(), "changed.json")
	write(t, file, `{"/repo/a.ts":[{"from":2,"to":3}]}`)
	noteShellChanged(file, delivery.ChangedLines{"/repo/b.ts": {{From: 7, To: 7}}}, map[string]int64{"/repo/b.ts": 100})
	state := loadChanged(file)
	if len(state.Lines) != 2 || state.ShellMtimes["/repo/b.ts"] != 100 {
		t.Fatalf("session state: %+v", state)
	}
}

func TestChangedFilesPrunedAfterAWeek(t *testing.T) {
	dir := t.TempDir()
	ev := contract.Event{Agent: "claude-code", SessionID: "old", Kind: contract.PostTool}
	noteChanged(ev, dir, []fileEdit{{path: "/repo/a.ts", ranges: []shift.Range{{From: 1, To: 1}}, placed: true}})
	file := changedPath(dir, ev)
	old := time.Now().Add(-8 * 24 * time.Hour)
	if err := os.Chtimes(file, old, old); err != nil {
		t.Fatal(err)
	}
	fresh := contract.Event{Agent: "claude-code", SessionID: "new", Kind: contract.PostTool}
	noteChanged(fresh, dir, []fileEdit{{path: "/repo/a.ts", ranges: []shift.Range{{From: 1, To: 1}}, placed: true}})
	pruneChanged(contract.Event{Agent: "claude-code", SessionID: "new", Kind: contract.SessionStart, Source: "startup"}, dir, time.Now())
	if _, err := os.Stat(file); !os.IsNotExist(err) {
		t.Fatal("week-old file kept")
	}
	if _, err := os.Stat(changedPath(dir, fresh)); err != nil {
		t.Fatal("fresh file removed")
	}
	if matches, _ := filepath.Glob(filepath.Join(dir, "changed", "*", "*.tmp")); len(matches) != 0 {
		t.Fatalf("temporary files left: %v", matches)
	}
}
