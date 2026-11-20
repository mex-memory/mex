package hook

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/mex-memory/mex/native/internal/contract"
	localrecord "github.com/mex-memory/mex/native/record"
)

func TestOutputLeversDefaultAndOverride(t *testing.T) {
	h, env := fakeHome(t, true)
	if h.outputLevers() {
		t.Fatal("default on")
	}
	write(t, filepath.Join(h.mex, "controls.json"), `{"version":1,"off":false,"capture":true,"levers":"on"}`)
	if !h.outputLevers() {
		t.Fatal("setting ignored")
	}
	for _, v := range []string{"on", "off"} {
		o := homeFrom(withEnv(env, map[string]string{"MEX_LEVERS": v}))
		if o.outputLevers() != (v == "on") {
			t.Fatal("override ignored")
		}
	}
}
func TestOutputLeversOffDoesNotTouchState(t *testing.T) {
	h, _ := fakeHome(t, true)
	d := t.TempDir()
	r, o := levers(contract.Event{Agent: "claude-code", SessionID: "s", Kind: contract.PreTool}, h, d, time.Now(), true)
	if !r.Empty() || o != nil {
		t.Fatal("off returned lever output")
	}
	e, err := os.ReadDir(d)
	if err != nil || len(e) != 0 {
		t.Fatalf("off touched state: %v %v", e, err)
	}
}

func TestWrapperOffRunsWholeWithoutState(t *testing.T) {
	h, env := fakeHome(t, true)
	env = withEnv(env, map[string]string{"MEX_LEVERS": "off"})
	shell, command := "sh", "npm() { i=0; while [ $i -lt 800 ]; do echo ordinary-line-padding-padding-padding; i=$((i+1)); done; }; npm test"
	if runtime.GOOS == "windows" {
		shell = "powershell"
		command = "function npm { 1..800 | ForEach-Object { 'ordinary-line-padding-padding-padding' } }; npm test"
	}
	var out, stderr bytes.Buffer
	if code := runWrapped([]string{"run", "--shell", shell, "--", command}, nil, &out, &stderr, env); code != 0 {
		t.Fatalf("exit %d: %s", code, stderr.String())
	}
	if strings.Contains(out.String(), "[MEX:") || strings.Count(out.String(), "ordinary-line-padding-padding-padding") != 801 {
		t.Fatal("output changed")
	}
	if _, err := os.Stat(filepath.Join(h.mex, "hooks.db")); !os.IsNotExist(err) {
		t.Fatal("off wrapper opened state")
	}
}
func TestOutlineRearmConsumesLedgerTimestampOnce(t *testing.T) {
	h, env := fakeHome(t, true)
	env = withEnv(env, map[string]string{"MEX_LEVERS": "on"})
	h = homeFrom(env)
	d := h.mex
	hooks, err := localrecord.OpenHooks(hooksLocation(h, d))
	if err != nil {
		t.Fatal(err)
	}
	err = hooks.UpdateLeverState("claude-code", "s", "", time.Now(), false, false, func(_ []byte, g *localrecord.OutlineGuard) ([]byte, error) {
		g.Outlines = 10
		g.Trips = 8
		g.Off = true
		g.OffSince = "earlier"
		return nil, nil
	})
	hooks.Close()
	if err != nil {
		t.Fatal(err)
	}
	stamp := time.Now().UnixMilli()
	write(t, filepath.Join(d, "ledger-off.outline"), fmt.Sprintf("{\"version\":1,\"off\":false,\"rearmed_at\":%d}", stamp))
	ev := contract.Event{Agent: "claude-code", SessionID: "s", Kind: contract.PreTool}
	levers(ev, h, d, time.Now(), false)
	g := testOutlineStats(t, d)
	if g.Off || g.Outlines != 0 || g.RearmedAt != stamp {
		t.Fatalf("not reset: %+v", g)
	}
	hooks, err = localrecord.OpenHooks(hooksLocation(h, d))
	if err != nil {
		t.Fatal(err)
	}
	err = hooks.UpdateLeverState("claude-code", "s", "", time.Now(), false, false, func(_ []byte, g *localrecord.OutlineGuard) ([]byte, error) { g.Outlines = 3; return nil, nil })
	hooks.Close()
	if err != nil {
		t.Fatal(err)
	}
	levers(ev, h, d, time.Now(), false)
	if g = testOutlineStats(t, d); g.Outlines != 3 {
		t.Fatalf("reset twice: %+v", g)
	}
}

func TestOutputOffShortPromptDoesNotOpenTopicState(t *testing.T) {
	h, _ := fakeHome(t, true)
	d := t.TempDir()
	ev := contract.Event{Agent: "claude-code", SessionID: "s", Checkout: d, Kind: contract.Prompt, Prompt: &contract.PromptIn{Text: "continue", Typed: true}}
	levers(ev, h, d, time.Now(), true)
	if e, err := os.ReadDir(d); err != nil || len(e) != 0 {
		t.Fatal("short prompt touched state", e, err)
	}
}
