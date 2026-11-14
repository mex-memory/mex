package hook

import (
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/internal/contract"
	localrecord "github.com/mex-memory/mex/native/record"
)

type unreadInput struct{ reads int }

func (r *unreadInput) Read([]byte) (int, error) { r.reads++; return 0, io.EOF }

func TestTerminalOffDoesNotReadInputOrHome(t *testing.T) {
	for _, agent := range []string{"claude-code", "codex"} {
		in := &unreadInput{}
		code, out := run(t, []string{agent, "UserPromptSubmit"}, in, func(key string) string {
			if key == "MEX_OFF" {
				return "1"
			}
			if key != "MEX_BACKGROUND" {
				t.Fatalf("off hook read %s", key)
			}
			return ""
		})
		assertEmptyReply(t, code, out)
		if in.reads != 0 {
			t.Fatal("off hook read stdin")
		}
	}
}

func TestOffAndBackgroundDoNotAddCompactionInstructions(t *testing.T) {
	for _, key := range []string{"MEX_OFF", "MEX_BACKGROUND"} {
		code, out := run(t, []string{"claude-code", "PreCompact"}, nil, func(k string) string {
			if k == key {
				return "1"
			}
			return ""
		})
		if code != 0 || out != "" {
			t.Fatalf("%s: code=%d out=%q", key, code, out)
		}
	}
}

func TestSessionControlsSurviveHookProcessRestarts(t *testing.T) {
	for _, agent := range []string{"claude-code", "codex"} {
		t.Run(agent, func(t *testing.T) {
			h, _ := fakeHome(t, true)
			root := repo(t, t.TempDir())
			register(t, h, root, projectID, "on", "")
			capture := t.TempDir()
			invoke := func(event, session, prompt string) string {
				t.Helper()
				payload, _ := json.Marshal(map[string]string{"session_id": session, "cwd": root, "prompt": prompt, "source": "resume"})
				cmd := exec.Command(os.Args[0], "-test.run=^TestControlPeer$")
				cmd.Env = append(os.Environ(), "MEX_CONTROL_TEST_PEER=1", "MEX_CONTROL_AGENT="+agent, "MEX_CONTROL_EVENT="+event, "MEX_HOME="+h.user, "HOME="+h.user, "USERPROFILE="+h.user, "MEX_HOOK_RECORD="+capture, "MEX_BACKGROUND=0", "MEX_OFF=0", "MEX_TELEMETRY=0")
				cmd.Stdin = strings.NewReader(string(payload))
				out, err := cmd.CombinedOutput()
				if err != nil {
					t.Fatalf("peer: %v %s", err, out)
				}
				return string(out)
			}
			if out := invoke("UserPromptSubmit", "s", "mex pause"); !strings.Contains(out, `"decision":"block"`) {
				t.Fatalf("pause: %s", out)
			}
			if out := invoke("SessionStart", "s", ""); out != "{}\n" {
				t.Fatalf("paused restart: %s", out)
			}
			if out := invoke("UserPromptSubmit", "s", "normal prompt"); out != "{}\n" {
				t.Fatalf("paused prompt: %s", out)
			}
			files, _ := filepath.Glob(filepath.Join(capture, agent, "*.json"))
			if len(files) != 0 {
				t.Fatal("paused or control text was captured")
			}
			hooks, err := localrecord.OpenHooks(localrecord.Location{Hooks: filepath.Join(h.mex, "hooks.db")})
			if err != nil {
				t.Fatal(err)
			}
			s, err := hooks.Session("s")
			hooks.Close()
			if err != nil || s == nil || !s.Paused {
				t.Fatalf("durable pause: %+v %v", s, err)
			}
			invoke("UserPromptSubmit", "other", "normal prompt")
			files, _ = filepath.Glob(filepath.Join(capture, agent, "*.json"))
			if len(files) != 1 {
				t.Fatal("pause affected another session")
			}
			if out := invoke("UserPromptSubmit", "s", "mex resume"); !strings.Contains(out, `"decision":"block"`) {
				t.Fatalf("resume: %s", out)
			}
			invoke("UserPromptSubmit", "s", "normal prompt")
			files, _ = filepath.Glob(filepath.Join(capture, agent, "*.json"))
			if len(files) != 2 {
				t.Fatal("resume did not restore capture")
			}
		})
	}
}

func TestControlPeer(t *testing.T) {
	if os.Getenv("MEX_CONTROL_TEST_PEER") != "1" {
		return
	}
	code := Run([]string{os.Getenv("MEX_CONTROL_AGENT"), os.Getenv("MEX_CONTROL_EVENT")}, os.Stdin, os.Stdout, io.Discard, os.Getenv)
	os.Exit(code)
}

func TestSessionControlRequiresAnExactMainTypedPrompt(t *testing.T) {
	ev := contract.Event{Kind: contract.Prompt, SessionID: "s", Prompt: &contract.PromptIn{Text: "mex pause", Typed: true}}
	if _, ok := sessionControl(ev); !ok {
		t.Fatal("typed control not recognized")
	}
	for _, text := range []string{"explain mex pause", "`mex pause`", "mex pause\nplease", " mex pause", "MEX PAUSE"} {
		ev.Prompt.Text = text
		if _, ok := sessionControl(ev); ok {
			t.Fatalf("consumed %q", text)
		}
	}
	ev.Prompt.Text = "mex pause"
	ev.Prompt.Typed = false
	if _, ok := sessionControl(ev); ok {
		t.Fatal("pasted provenance ignored")
	}
	ev.Prompt.Typed = true
	ev.AgentID = "child"
	if _, ok := sessionControl(ev); ok {
		t.Fatal("subagent control consumed")
	}
}

func TestControlsKeepCaptureAndBroaderOffIndependent(t *testing.T) {
	h, original := fakeHome(t, true)
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "on", "")
	capture := t.TempDir()
	env := func(k string) string {
		if k == "MEX_HOOK_RECORD" {
			return capture
		}
		return original(k)
	}
	previous := startBackground
	starts := 0
	startBackground = func(home, string) { starts++ }
	defer func() { startBackground = previous }()
	payload, _ := json.Marshal(map[string]string{"session_id": "s", "cwd": root, "prompt": "ordinary"})
	write(t, filepath.Join(h.mex, "controls.json"), `{"version":1,"off":false,"capture":false}`)
	run(t, []string{"claude-code", "SessionStart"}, strings.NewReader(string(payload)), env)
	files, _ := filepath.Glob(filepath.Join(capture, "claude-code", "*.json"))
	if starts != 1 || len(files) != 0 {
		t.Fatal("capture off affected delivery work or saved text")
	}
	write(t, filepath.Join(h.mex, "controls.json"), `{"version":1,"off":true,"capture":true}`)
	run(t, []string{"claude-code", "SessionStart"}, strings.NewReader(string(payload)), env)
	if starts != 1 {
		t.Fatal("global off started work")
	}
	control, _ := json.Marshal(map[string]string{"session_id": "s", "cwd": root, "prompt": "mex resume"})
	_, out := run(t, []string{"claude-code", "UserPromptSubmit"}, strings.NewReader(string(control)), env)
	if !strings.Contains(out, "still off everywhere") || !h.controls().Off {
		t.Fatalf("resume cleared global off: %s", out)
	}
	write(t, filepath.Join(h.mex, "controls.json"), `{"version":1,"off":false,"capture":true}`)
	write(t, filepath.Join(h.mex, "hook-capture", projectID+".json"), `{"version":1,"enabled":false}`)
	run(t, []string{"claude-code", "SessionStart"}, strings.NewReader(string(payload)), env)
	files, _ = filepath.Glob(filepath.Join(capture, "claude-code", "*.json"))
	if starts != 2 || len(files) != 0 {
		t.Fatal("project capture off changed delivery")
	}
	register(t, h, root, projectID, "off until", time.Now().Add(-time.Minute).Format(time.RFC3339Nano))
	if _, state := findCheckout(h.mex, root, false, time.Now()); state != switchedOn {
		t.Fatal("timed off did not expire")
	}
}

func TestFailedSessionWriteLeavesPromptUnconsumed(t *testing.T) {
	h, env := fakeHome(t, true)
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "on", "")
	write(t, filepath.Join(h.mex, "hook-paused"), "not a directory")
	data, _ := json.Marshal(map[string]string{"session_id": "s", "cwd": root, "prompt": "mex pause"})
	code, out := run(t, []string{"claude-code", "UserPromptSubmit"}, strings.NewReader(string(data)), env)
	assertEmptyReply(t, code, out)
}

func TestMalformedControlsDisableMEXWithoutBlockingAgent(t *testing.T) {
	h, env := fakeHome(t, true)
	root := repo(t, t.TempDir())
	register(t, h, root, projectID, "on", "")
	for _, body := range []string{"null", "{}", `{"version":2,"off":false,"capture":true}`, "broken", strings.Repeat("x", 4097)} {
		write(t, filepath.Join(h.mex, "controls.json"), body)
		if !h.controls().Off {
			t.Fatalf("accepted %q", body[:min(len(body), 30)])
		}
		payload, _ := json.Marshal(map[string]string{"session_id": "s", "cwd": root})
		code, out := run(t, []string{"claude-code", "SessionStart"}, strings.NewReader(string(payload)), env)
		assertEmptyReply(t, code, out)
	}
}
