// Package hook is the entry point every agent hook calls.
//
// Whatever happens in here, the agent must keep working: Run always returns 0
// and always writes one valid JSON reply. Anything unexpected becomes the empty
// reply, which means "do nothing".
package hook

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/mex-memory/mex/native/delivery"
	"github.com/mex-memory/mex/native/internal/adapter"
	_ "github.com/mex-memory/mex/native/internal/adapter/antigravity" // registers the profile
	_ "github.com/mex-memory/mex/native/internal/adapter/claude"      // registers the profile
	_ "github.com/mex-memory/mex/native/internal/adapter/codex"       // registers the profile
	_ "github.com/mex-memory/mex/native/internal/adapter/cursor"      // registers the profile
	_ "github.com/mex-memory/mex/native/internal/adapter/gemini"      // registers the profile
	"github.com/mex-memory/mex/native/internal/contract"
	localrecord "github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
)

// Version is set at build time with -ldflags "-X .../hook.Version=...".
var Version = "dev"

const (
	// maxPayload caps how much of a hook payload is read. Larger payloads are
	// drained and ignored rather than buffered.
	maxPayload = 8 << 20
	// readTimeout stops a hook from hanging when an agent keeps stdin open.
	readTimeout = 2 * time.Second
)

// emptyReply is valid output for every supported agent and means "do nothing".
var emptyReply = []byte("{}\n")

// Env is the subset of the process environment the shim looks at.
type Env func(key string) string

// Run handles one hook call and returns the process exit code, which is always 0.
func Run(args []string, stdin io.Reader, stdout, stderr io.Writer, getenv Env) (code int) {
	started := time.Now()
	defer func() {
		if r := recover(); r != nil {
			code = 0
			_, _ = stdout.Write(emptyReply)
		}
	}()

	if len(args) > 0 {
		switch args[0] {
		case "--self-test":
			return selfTest(stdout)
		case "--version":
			_, _ = io.WriteString(stdout, Version+"\n")
			return 0
		case "--status":
			return status(stdout, homeFrom(getenv), runtime.GOOS)
		case "--cleanup-orphan":
			if getenv("MEX_BACKGROUND") != "1" {
				cleanupOrphan(homeFrom(getenv), orphanCleanupTimeout)
			}
			return 0
		case "--check-stage":
			return checkStage(args[1:], getenv)
		case "--check-run":
			return checkRun(stdin, stdout)
		case "--delivery-probe":
			return deliveryProbe(stdin, stdout)
		case "--brief-run":
			return briefRun(stdin, stdout)
		case "--delivery-replay":
			return deliveryReplay(stdin, stdout, getenv)
		case "--pair-study":
			return pairStudy(stdin, stdout)
		case "--probe":
			return explicitProbe(stdin, stdout, getenv)
		case "--recall":
			return recallRank(stdin, stdout)
		}
	}

	// Terminal-wide off and MEX's own runs do nothing before reading input,
	// resolving storage, capturing payloads or starting background work.
	if getenv("MEX_OFF") == "1" || getenv("MEX_BACKGROUND") == "1" {
		out := emptyReply
		if len(args) >= 2 {
			if profile, found := adapter.Lookup(args[0]); found {
				out = profile.EmptyReply(args[1])
			}
		}
		_, _ = stdout.Write(out)
		return 0
	}
	for _, arg := range args {
		if arg == "--mex-managed" {
			// Prototype project registrations are inert after machine install.
			return 0
		}
	}

	payload, ok := readPayload(stdin, readTimeout)

	// Registered command lines are `mex-hook <agent> <event>`.
	if len(args) < 2 {
		_, _ = stdout.Write(emptyReply)
		return 0
	}
	agent, nativeEvent := args[0], args[1]
	h := homeFrom(getenv)
	if len(args) > 2 && args[2] == "--delivery-trace" {
		h.deliveryError = func(err error) { _, _ = fmt.Fprintln(stderr, "delivery failed:", err) }
		h.deliveryTrace = func(name string, elapsed time.Duration) {
			_, _ = fmt.Fprintf(stderr, "delivery phase %s %d\n", name, elapsed.Nanoseconds())
		}
	}
	if dir := getenv("MEX_HOOK_RECORD"); dir != "" && ok {
		h.capture = func(ev contract.Event, directory string, global controls) {
			if captureEnabled(directory, ev.ProjectID, global) {
				record(dir, ev.Agent, nativeEvent, payload)
			}
		}
	}
	resolveUsage := sync.OnceValues(func() (place.Location, bool) { return hookUsageLocation(h, getenv) })
	h.usageLocation = resolveUsage
	_, _ = stdout.Write(handle(agent, nativeEvent, payload, ok, h, time.Now(), func(actual string, sessionStart, failed bool) {
		usageLocation, usageEnabled := resolveUsage()
		if usageEnabled {
			recordHookUsage(usageLocation, actual, sessionStart, failed, time.Since(started))
		}
	}))
	return 0
}

// silent is the reply when the hook ran in an agent MEX has no profile for.
// Empty output with exit 0 means "do nothing" to every agent.
var silent = []byte{}

// handle turns one payload into the agent's reply after consent and checkout
// resolution. Delivery errors are ignored so every agent call can continue.
func handle(agent, nativeEvent string, payload []byte, ok bool, h home, now time.Time, observe ...func(string, bool, bool)) []byte {
	if !ok {
		if p, found := adapter.Lookup(agent); found {
			if len(observe) > 0 && !h.controls().Off {
				observe[0](agent, false, true)
			}
			return p.EmptyReply(nativeEvent)
		}
		return emptyReply
	}

	// A hook registered for one agent may be running inside another.
	if real := adapter.Detect(payload); real != "" && real != agent {
		if _, known := adapter.Lookup(real); !known || h.hasOwnHooks(real) {
			// Its own MEX hooks answer it, or MEX can't speak its format.
			return silent
		}
		agent = real
	}

	profile, found := adapter.Lookup(agent)
	if !found {
		return emptyReply
	}
	global := h.controls()
	observeAllowed := !global.Off
	sessionStart, failed := false, false
	defer func() {
		if observeAllowed && len(observe) > 0 {
			observe[0](agent, sessionStart, failed)
		}
	}()
	var instruction *adapter.InstructionLoad
	ev, err := profile.Parse(nativeEvent, payload)
	if observer, ok := profile.(adapter.InstructionObserver); ok && err != nil {
		load, handled, loadErr := observer.ParseInstructionLoad(nativeEvent, payload)
		if handled {
			ev, err, instruction = load.Event, loadErr, &load
		}
	}
	if errors.Is(err, adapter.ErrSkip) {
		return profile.EmptyReply(nativeEvent)
	}
	if err != nil {
		failed = true
		return profile.EmptyReply(nativeEvent)
	}
	sessionStart = ev.Kind == contract.SessionStart
	if _, control := sessionControl(ev); global.Off && !control && !whatPrompt(ev) {
		return profile.EmptyReply(nativeEvent)
	}
	if h.orphaned(sessionStart) {
		return profile.EmptyReply(nativeEvent)
	}
	if !h.mexInstalled() {
		if !global.Off && h.capture != nil {
			h.capture(ev, "", global)
		}
		out, _ := profile.Render(ev, contract.Reply{})
		return out
	}

	// Where MEX isn't on, exit at once: nothing behind this line runs. A repo
	// MEX was never turned on in gets one notice, at the first session there.
	recordDirectory := h.recordDirectory()
	path, isFile := eventPath(ev)
	checkout, state := findCheckout(recordDirectory, path, isFile, now)
	ev.ProjectID, ev.Checkout = checkout.ProjectID, checkout.Root
	if whatPrompt(ev) && state != unregistered {
		observeAllowed = false
		support, _ := profile.Capabilities().Support(contract.Prompt)
		if !support.ConsumePrompt {
			return profile.EmptyReply(nativeEvent)
		}
		for _, name := range []string{"hooks.db", "hooks.db-wal", "hooks.db-shm"} {
			if !safeTelemetryFile(filepath.Join(recordDirectory, name)) {
				return profile.EmptyReply(nativeEvent)
			}
		}
		summary, err := localrecord.ReadWhat(filepath.Join(recordDirectory, "hooks.db"), ev.SessionID, ev.ProjectID, ev.Checkout)
		if err != nil {
			return profile.EmptyReply(nativeEvent)
		}
		out, _ := profile.Render(ev, contract.Reply{ConsumePrompt: true, PersonLine: summary.Line()})
		return out
	}
	if paused, recognized := sessionControl(ev); recognized && state != unregistered {
		observeAllowed = false
		support, _ := profile.Capabilities().Support(contract.Prompt)
		if !support.ConsumePrompt || !changeSessionPause(ev, recordDirectory, paused) {
			return profile.EmptyReply(nativeEvent)
		}
		line := "MEX is resumed for this session."
		if paused {
			line = "MEX is paused for this session. Type `mex resume` to resume."
		}
		if global.Off {
			line += " MEX is still off everywhere."
		} else if state == switchedOff {
			line += " MEX is still off for this repo."
		}
		out, _ := profile.Render(ev, contract.Reply{ConsumePrompt: true, PersonLine: line})
		return out
	}
	if global.Off || state == switchedOff || sessionPaused(recordDirectory, agent, ev.SessionID) {
		observeAllowed = false
		return profile.EmptyReply(nativeEvent)
	}
	h.beat(agent, ev.SessionID, ev.Cwd, ev.Kind == contract.SessionStart, now)
	if h.capture != nil {
		h.capture(ev, recordDirectory, global)
	}
	if state != switchedOn {
		reply := contract.Reply{}
		if state == unregistered && ev.Kind == contract.SessionStart && ev.AgentID == "" && firstOffNotice(recordDirectory, ev.Cwd) {
			reply.PersonLine = offNotice
		}
		out, _ := profile.Render(ev, reply)
		return out
	}
	if instruction != nil {
		observeInstruction(ev, h, recordDirectory, instruction.Path)
		return profile.EmptyReply(nativeEvent)
	}

	if ev.Kind == contract.SessionStart {
		startBackground(h, recordDirectory)
	}
	noteEdit(ev, recordDirectory)
	freeStage(ev, h, recordDirectory)
	reply, deliveryErr := delivery.Handle(ev, delivery.Environment{Trace: h.deliveryTrace, Scorer: h.scorer, Home: h.mex, RecordDirectory: recordDirectory, Now: now, KeepSession: func(agent, id string) bool {
		info, err := os.Stat(filepath.Join(h.heartbeatDir(agent), safeName(id)))
		if err != nil {
			return !os.IsNotExist(err)
		}
		return now.Sub(info.ModTime()) <= 30*24*time.Hour
	}, Resolve: func(path string, isFile bool) (string, string) {
		// Each touched path picks its own repo; one that is off or not
		// registered gets nothing.
		c, st := findCheckout(recordDirectory, path, isFile, now)
		if st != switchedOn {
			return "", ""
		}
		return c.ProjectID, c.Root
	}})
	if deliveryErr != nil {
		if h.deliveryError != nil {
			h.deliveryError(deliveryErr)
		}
		failed = true
		reply = contract.Reply{}
	}
	out, _ := profile.Render(ev, reply)
	return out
}

// recordDirectory is where the local record lives: MEX's folder, or the cache
// folder the location pointer names for a network home. Callers check that MEX
// is installed. Reuse telemetry's validated location when available; otherwise
// the checkout-only lookup skips network detection and reads Node's pointer.
func (h home) recordDirectory() string {
	if h.usageLocation != nil {
		if location, enabled := h.usageLocation(); enabled {
			return location.Directory
		}
	}
	// The usual case costs one small read: no pointer yet (no writer has run,
	// so nothing is elsewhere), or a pointer naming MEX's own folder.
	data, err := os.ReadFile(filepath.Join(h.mex, "location"))
	if err != nil {
		return h.mex
	}
	if own, err := place.AbsolutePath(h.mex); err == nil && strings.TrimSpace(string(data)) == own {
		return h.mex
	}
	location, err := place.ResolveLocation(place.LocationOptions{Home: h.mex, ReadOnly: true, IsNetwork: func(string) (bool, error) { return false, errNoDetection }})
	if err != nil {
		return ""
	}
	return location.Directory
}

// record saves a raw payload for building fixtures. Only runs when the person
// sets MEX_HOOK_RECORD; payloads can hold private session text.
func record(dir, agent, nativeEvent string, payload []byte) {
	folder := filepath.Join(dir, filepath.Base(agent))
	if os.MkdirAll(folder, 0o700) != nil {
		return
	}
	name := fmt.Sprintf("%s-%d.json", filepath.Base(nativeEvent), time.Now().UnixNano())
	_ = os.WriteFile(filepath.Join(folder, name), payload, 0o600)
}

// readPayload reads up to maxPayload bytes, then drains the rest so the agent
// never sees a broken pipe. It gives up after timeout and returns what it has.
func readPayload(r io.Reader, timeout time.Duration) ([]byte, bool) {
	if r == nil {
		return nil, true
	}
	type result struct {
		data []byte
		ok   bool
	}
	done := make(chan result, 1)
	go func() {
		data, err := io.ReadAll(io.LimitReader(r, maxPayload))
		if err != nil {
			done <- result{data, false}
			return
		}
		n, _ := io.Copy(io.Discard, r)
		done <- result{data, n == 0}
	}()
	select {
	case res := <-done:
		return res.data, res.ok
	case <-time.After(timeout):
		return nil, false
	}
}
