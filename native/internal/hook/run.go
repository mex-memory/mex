// Package hook is the entry point every agent hook calls.
//
// Whatever happens in here, the agent must keep working: Run always returns 0
// and always writes one valid JSON reply. Anything unexpected becomes the empty
// reply, which means "do nothing".
package hook

import (
	"io"
	"time"
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
		}
	}

	// MEX's own background runs must never trigger MEX.
	if getenv("MEX_BACKGROUND") == "1" {
		_, _ = stdout.Write(emptyReply)
		return 0
	}

	_, _ = readPayload(stdin, readTimeout)

	_, _ = stdout.Write(emptyReply)
	return 0
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
