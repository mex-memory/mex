package hook

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/record/place"
)

const projectID = "g-0123456789abcdef01234567"

// repo makes a Git checkout folder and returns its path.
func repo(t *testing.T, parent string) string {
	t.Helper()
	dir := filepath.Join(parent, "repo")
	if err := os.MkdirAll(filepath.Join(dir, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	return dir
}

// register writes the mirror Node writes for a checkouts row.
func register(t *testing.T, h home, root, id, state, offUntil string) {
	t.Helper()
	real, err := place.RealPath(root)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(hookCheckout{Version: 1, ProjectID: id, Root: real, State: state, OffUntil: offUntil})
	write(t, filepath.Join(h.mex, "hook-checkouts", place.ShortHash(real)+".json"), string(body))
}

func TestFindCheckout(t *testing.T) {
	now := time.Date(2026, 11, 13, 12, 0, 0, 0, time.UTC)
	h, _ := fakeHome(t, true)
	root := repo(t, t.TempDir())
	file := filepath.Join(root, "src", "a.ts")
	write(t, file, "x")

	if _, w := findCheckout(h.mex, file, true, now); w != unregistered {
		t.Fatalf("nothing registered: got %v", w)
	}
	register(t, h, root, projectID, "on", "")
	for _, p := range []string{file, root, filepath.Join(root, "src", "new", "b.ts")} {
		c, w := findCheckout(h.mex, p, false, now)
		real, _ := place.RealPath(root)
		if w != switchedOn || c.ProjectID != projectID || c.Root != real {
			t.Errorf("%s: got %+v %v", p, c, w)
		}
	}

	register(t, h, root, projectID, "off", "")
	if _, w := findCheckout(h.mex, file, true, now); w != switchedOff {
		t.Errorf("off: got %v", w)
	}
	register(t, h, root, projectID, "off until", now.Add(time.Hour).Format(time.RFC3339Nano))
	if _, w := findCheckout(h.mex, file, true, now); w != switchedOff {
		t.Errorf("off until later: got %v", w)
	}
	register(t, h, root, projectID, "off until", now.Add(-time.Minute).Format(time.RFC3339Nano))
	if _, w := findCheckout(h.mex, file, true, now); w != switchedOn {
		t.Errorf("off until earlier: got %v", w)
	}
}

func TestFindCheckoutStopsAtNestedRepo(t *testing.T) {
	h, _ := fakeHome(t, true)
	outer := repo(t, t.TempDir())
	register(t, h, outer, projectID, "on", "")
	inner := filepath.Join(outer, "vendor", "lib")
	if err := os.MkdirAll(filepath.Join(inner, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, w := findCheckout(h.mex, filepath.Join(inner, "x.go"), true, time.Now()); w != unregistered {
		t.Errorf("a nested unregistered repo is not the outer project: got %v", w)
	}
}

func TestFolderProjectCoversOnlyItsFolder(t *testing.T) {
	h, _ := fakeHome(t, true)
	folder := t.TempDir()
	register(t, h, folder, "f-0123456789abcdef01234567", "on", "")
	if _, w := findCheckout(h.mex, folder, false, time.Now()); w != switchedOn {
		t.Errorf("the folder itself: got %v", w)
	}
	sub := filepath.Join(folder, "sub")
	if err := os.MkdirAll(sub, 0o700); err != nil {
		t.Fatal(err)
	}
	if _, w := findCheckout(h.mex, sub, false, time.Now()); w != unregistered {
		t.Errorf("same rule as Node's RecordWriter.checkout: got %v", w)
	}
}

func TestBrokenMirrorCountsAsUnregistered(t *testing.T) {
	h, _ := fakeHome(t, true)
	root := repo(t, t.TempDir())
	real, _ := place.RealPath(root)
	mirror := filepath.Join(h.mex, "hook-checkouts", place.ShortHash(real)+".json")
	for _, body := range []string{"not json", `{"version":2,"project_id":"g-1","root":"` + strings.ReplaceAll(real, `\`, `\\`) + `","state":"on"}`, `{"version":1,"project_id":"g-1","root":"/elsewhere","state":"on"}`} {
		write(t, mirror, body)
		if _, w := findCheckout(h.mex, root, false, time.Now()); w != unregistered {
			t.Errorf("%s: got %v", body, w)
		}
	}
}

func sessionStart(cwd string) string {
	b, _ := json.Marshal(map[string]any{"session_id": "s1", "hook_event_name": "SessionStart", "source": "startup", "cwd": cwd})
	return string(b)
}

func TestOffNoticeOncePerRepo(t *testing.T) {
	_, env := fakeHome(t, true)
	root := repo(t, t.TempDir())
	sub := filepath.Join(root, "pkg")
	if err := os.MkdirAll(sub, 0o700); err != nil {
		t.Fatal(err)
	}
	code, out := run(t, []string{"claude-code", "SessionStart"}, strings.NewReader(sessionStart(sub)), env)
	var reply struct {
		SystemMessage string `json:"systemMessage"`
	}
	if err := json.Unmarshal([]byte(out), &reply); code != 0 || err != nil || reply.SystemMessage != offNotice {
		t.Fatalf("first session: code %d, %q", code, out)
	}
	// Same repo, another folder and another agent: once per repo.
	for _, agent := range []string{"claude-code", "codex"} {
		_, out = run(t, []string{agent, "SessionStart"}, strings.NewReader(sessionStart(root)), env)
		assertEmptyReply(t, 0, out)
	}
	// Other events never carry it.
	_, out = run(t, []string{"claude-code", "Stop"}, strings.NewReader(`{"session_id":"s","hook_event_name":"Stop","cwd":"`+strings.ReplaceAll(t.TempDir(), `\`, `\\`)+`"}`), env)
	assertEmptyReply(t, 0, out)
}

func TestOffNoticeCodexFormat(t *testing.T) {
	_, env := fakeHome(t, true)
	root := repo(t, t.TempDir())
	_, out := run(t, []string{"codex", "SessionStart"}, strings.NewReader(sessionStart(root)), env)
	if !strings.Contains(out, `"systemMessage":"MEX is off here.`) {
		t.Fatalf("got %q", out)
	}
}

func TestNoNoticeWhenSwitchedOffOrInSubagentOrWithoutMex(t *testing.T) {
	h, env := fakeHome(t, true)
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "off", "")
	_, out := run(t, []string{"claude-code", "SessionStart"}, strings.NewReader(sessionStart(root)), env)
	assertEmptyReply(t, 0, out)

	other := repo(t, t.TempDir())
	sub, _ := json.Marshal(map[string]any{"session_id": "s1", "hook_event_name": "SessionStart", "cwd": other, "agent_id": "a1"})
	_, out = run(t, []string{"claude-code", "SessionStart"}, bytes.NewReader(sub), env)
	assertEmptyReply(t, 0, out)

	h2, env2 := fakeHome(t, false)
	_, out = run(t, []string{"claude-code", "SessionStart"}, strings.NewReader(sessionStart(repo(t, t.TempDir()))), env2)
	assertEmptyReply(t, 0, out)
	if _, err := os.Stat(h2.mex); !os.IsNotExist(err) {
		t.Fatal("the shim must never create ~/.mex")
	}
}

func TestBackgroundStartsOnlyWhereMexIsOnAndWorkWaits(t *testing.T) {
	h, env := fakeHome(t, true)
	root := repo(t, t.TempDir())
	started := 0
	saved := startBackground
	startBackground = func(hh home, dir string) {
		if workWaiting(hh, dir) {
			started++
		}
	}
	t.Cleanup(func() { startBackground = saved })

	call := func() { run(t, []string{"claude-code", "SessionStart"}, strings.NewReader(sessionStart(root)), env) }
	write(t, filepath.Join(h.mex, "jobs-pending"), "")
	call() // not registered
	register(t, h, root, projectID, "off", "")
	call() // off
	if started != 0 {
		t.Fatalf("started %d times where MEX isn't on", started)
	}
	register(t, h, root, projectID, "on", "")
	call()
	if started != 1 {
		t.Fatalf("started %d times, want 1", started)
	}
	_ = os.Remove(filepath.Join(h.mex, "jobs-pending"))
	write(t, filepath.Join(h.mex, "index-pending"), "")
	call()
	if started != 2 {
		t.Fatalf("index-pending: started %d times, want 2", started)
	}
}

// TestMain doubles as the fake `node` the background start runs: with
// MEX_HOOK_FAKE_NODE set it records its arguments and exits.
func TestMain(m *testing.M) {
	if out := os.Getenv("MEX_HOOK_FAKE_NODE"); out != "" {
		_ = os.WriteFile(out, []byte(strings.Join(os.Args[1:], "\n")), 0o600)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestStartBackgroundRunsTheLauncher(t *testing.T) {
	h, _ := fakeHome(t, true)
	entry := filepath.Join(t.TempDir(), "cli.js")
	write(t, entry, "")
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	launch, _ := json.Marshal(launcher{Version: 1, Node: self, Entry: entry})
	write(t, filepath.Join(h.mex, "bin", "launcher.json"), string(launch))
	marker := filepath.Join(t.TempDir(), "ran")
	t.Setenv("MEX_HOOK_FAKE_NODE", marker)

	startBackground(h, h.mex) // no work waiting
	time.Sleep(200 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("started with no work waiting")
	}

	write(t, filepath.Join(h.mex, "jobs-pending"), "")
	startBackground(h, h.mex)
	deadline := time.Now().Add(10 * time.Second)
	for {
		if got, err := os.ReadFile(marker); err == nil && len(got) > 0 {
			if want := entry + "\n__ensure-background"; string(got) != want {
				t.Fatalf("ran with %q, want %q", got, want)
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("the launcher never ran")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestStartBackgroundSkipsAMissingCli(t *testing.T) {
	h, _ := fakeHome(t, true)
	self, _ := os.Executable()
	launch, _ := json.Marshal(launcher{Version: 1, Node: self, Entry: filepath.Join(t.TempDir(), "gone.js")})
	write(t, filepath.Join(h.mex, "bin", "launcher.json"), string(launch))
	write(t, filepath.Join(h.mex, "jobs-pending"), "")
	marker := filepath.Join(t.TempDir(), "ran")
	t.Setenv("MEX_HOOK_FAKE_NODE", marker)
	startBackground(h, h.mex)
	time.Sleep(300 * time.Millisecond)
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("ran a launcher whose CLI is gone")
	}
}
