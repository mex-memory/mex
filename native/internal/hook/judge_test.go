package hook

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/check"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record/place"
)

func judgeRequestAt(t *testing.T, directory, checkout string) map[string]any {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(directory, "judge-pending", place.ShortHash(checkout)+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var request map[string]any
	if err := json.Unmarshal(data, &request); err != nil {
		t.Fatal(err)
	}
	return request
}

func TestJudgeRequestKeepsTheHostAndWaitsForIdle(t *testing.T) {
	directory, checkout := t.TempDir(), t.TempDir()
	ev := contract.Event{ProjectID: projectID, Checkout: checkout, Agent: "codex", Kind: contract.SessionStart}
	requestJudge(ev, directory, nil)
	start := judgeRequestAt(t, directory, checkout)
	if start["agent"] != "codex" || start["project_id"] != projectID || start["checkout"] != checkout || start["reason"] != "start" {
		t.Fatalf("wrong request: %v", start)
	}
	if start["not_before"].(float64) > float64(time.Now().UnixMilli()) {
		t.Fatal("session-start work was deferred")
	}
	ev.Kind = contract.PostTool
	requestJudge(ev, directory, []string{"src/api.ts"})
	edit := judgeRequestAt(t, directory, checkout)
	if edit["reason"] != "edit" || edit["near"].([]any)[0] != "src/api.ts" || edit["not_before"].(float64) < float64(time.Now().Add(29*time.Second).UnixMilli()) {
		t.Fatalf("edit did not wait for idle: %v", edit)
	}
	ev.Kind = contract.Stop
	requestJudge(ev, directory, nil)
	stop := judgeRequestAt(t, directory, checkout)
	if stop["reason"] != "idle" || stop["not_before"].(float64) > float64(time.Now().UnixMilli()) || stop["generation"] == edit["generation"] || stop["near"].([]any)[0] != "src/api.ts" {
		t.Fatalf("idle did not replace the deferred request: %v", stop)
	}
	files, _ := os.ReadDir(filepath.Join(directory, "judge-pending"))
	if len(files) != 1 {
		t.Fatalf("request staging files leaked: %d", len(files))
	}
}

func TestJudgeGenerationsStayDistinctWhenTheClockRepeats(t *testing.T) {
	directory, checkout := t.TempDir(), t.TempDir()
	ev := contract.Event{ProjectID: projectID, Checkout: checkout, Agent: "codex", Kind: contract.SessionStart}
	frozen := time.Unix(1_800_000_000, 0)
	seen := map[string]bool{}
	for i := 0; i < 8; i++ {
		if !requestJudgeAt(ev, directory, nil, frozen) {
			t.Fatal("request failed")
		}
		request := judgeRequestAt(t, directory, checkout)
		generation := request["generation"].(string)
		if generation == "" || len(generation) > 24 || strings.Trim(generation, "0123456789") != "" || seen[generation] {
			t.Fatalf("reused or incompatible generation: %q", generation)
		}
		seen[generation] = true
		if request["not_before"].(float64) != float64(frozen.UnixMilli()) {
			t.Fatal("generation changed scheduling time")
		}
	}
}

func TestJudgeWakeupFollowsSessionSetupAndFreeChecks(t *testing.T) {
	h, env := fakeHome(t, true)
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "on", "")
	// Only a real unresolved entry requests work; empty checkouts stay quiet.
	write(t, filepath.Join(root, ".mex", "learned", "mx_missing.md"), "---\nmex:\n  id: mx_missing\n  kind: fact\n  scope: [\"**\"]\n  source: {type: config, ref: missing.txt}\n  evidence: mined\n  one_line: A missing file.\n  checks:\n    - kind: source\n      role: complete\n      target: {file: missing.txt}\n      saw: {hash: \"sha256:"+strings.Repeat("a", 64)+"\"}\n      files: {}\n  status: active\n  created: 2026-11-15\n---\nA missing file.\n")
	canonical, err := place.RealPath(root)
	if err != nil {
		t.Fatal(err)
	}
	saved := startBackground
	starts := 0
	startBackground = func(h home, directory string) {
		starts++
		if !workWaiting(h, directory) {
			t.Fatal("Node woke before the judge request existed")
		}
		request := judgeRequestAt(t, directory, canonical)
		if request["agent"] != "claude-code" {
			t.Fatalf("wrong originating host: %v", request)
		}
	}
	t.Cleanup(func() { startBackground = saved })
	run(t, []string{"claude-code", "SessionStart"}, strings.NewReader(sessionStart(root)), env)
	if starts != 1 {
		t.Fatalf("background starts: %d", starts)
	}
}

func TestJudgeSkipsEmptyAndUnchangedStages(t *testing.T) {
	for _, report := range []check.StageReport{{}, {Counts: map[string]int{check.Held: 4}}, {Results: []check.Result{{Checks: []check.CheckResult{{Role: check.Supporting, FilesChanged: []string{"x"}}}}}}} {
		if needsJudge(report) {
			t.Fatal("a resolved stage requested a judge")
		}
	}
	// A held procedure whose symbol moved: only the judge job writes the new place back.
	moved := check.StageReport{Counts: map[string]int{check.Held: 1}, Items: []check.StageItem{{Status: "active", Level: "personal", Kind: "procedure"}},
		Results: []check.Result{{Checks: []check.CheckResult{{Role: check.Supporting, Status: check.Pass, Relink: &check.SymbolRelink{File: "src/b.ts", Symbol: "load"}}}}}}
	for _, report := range []check.StageReport{{Unfinished: true}, {Counts: map[string]int{check.Changed: 1}}, {Counts: map[string]int{check.Broken: 1}}, {Results: []check.Result{{Checks: []check.CheckResult{{Role: check.Complete, FilesChanged: []string{"x"}}}}}}, moved} {
		if !needsJudge(report) {
			t.Fatal("unresolved or spare work did not request a judge")
		}
	}
	directory := t.TempDir()
	if requestJudge(contract.Event{ProjectID: projectID, Checkout: t.TempDir(), Agent: "codex", Kind: contract.Stop}, directory, nil) {
		t.Fatal("Stop created an empty job")
	}
}

func TestJudgeStopDoesNotReleaseAnotherSession(t *testing.T) {
	directory, checkout := t.TempDir(), t.TempDir()
	ev := contract.Event{ProjectID: projectID, Checkout: checkout, Agent: "codex", SessionID: "editing", Kind: contract.PostTool}
	requestJudge(ev, directory, []string{"src/api.ts"})
	ev.SessionID, ev.Kind = "other", contract.Stop
	if requestJudge(ev, directory, nil) {
		t.Fatal("another session released active edits")
	}
	if judgeRequestAt(t, directory, checkout)["reason"] != "edit" {
		t.Fatal("pending edit was overwritten")
	}
}

func TestJudgeRequestDoesNothingWithoutACheckoutOrSupportedHost(t *testing.T) {
	directory := t.TempDir()
	requestJudge(contract.Event{}, directory, nil)
	requestJudge(contract.Event{ProjectID: projectID, Checkout: t.TempDir(), Agent: "unknown"}, directory, nil)
	if _, err := os.Stat(filepath.Join(directory, "judge-pending")); !os.IsNotExist(err) {
		t.Fatal("an invalid event created a judge request")
	}
}

func TestJudgeRequestRefusesARedirectedDirectory(t *testing.T) {
	directory, outside := t.TempDir(), t.TempDir()
	if err := os.Symlink(outside, filepath.Join(directory, "judge-pending")); err != nil {
		t.Skip("symlinks are unavailable")
	}
	requestJudge(contract.Event{ProjectID: projectID, Checkout: t.TempDir(), Agent: "codex", Kind: contract.SessionStart}, directory, nil)
	files, err := os.ReadDir(outside)
	if err != nil || len(files) != 0 {
		t.Fatalf("redirected request escaped: %v %v", files, err)
	}
}
