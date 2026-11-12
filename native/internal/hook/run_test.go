package hook

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"time"
)

func noEnv(string) string { return "" }

func run(t *testing.T, args []string, stdin io.Reader, env Env) (int, string) {
	t.Helper()
	var out bytes.Buffer
	code := Run(args, stdin, &out, io.Discard, env)
	return code, out.String()
}

func assertEmptyReply(t *testing.T, code int, out string) {
	t.Helper()
	if code != 0 {
		t.Fatalf("exit code = %d, want 0", code)
	}
	var reply map[string]any
	if err := json.Unmarshal([]byte(out), &reply); err != nil {
		t.Fatalf("reply %q is not valid JSON: %v", out, err)
	}
	if len(reply) != 0 {
		t.Fatalf("reply = %q, want the empty reply", out)
	}
}

func TestNoOpReturnsEmptyReply(t *testing.T) {
	code, out := run(t, nil, strings.NewReader(`{"hook_event_name":"PreToolUse"}`), noEnv)
	assertEmptyReply(t, code, out)
}

func TestMalformedPayloadFailsOpen(t *testing.T) {
	for _, in := range []string{"", "not json", "{", "\x00\xff"} {
		code, out := run(t, nil, strings.NewReader(in), noEnv)
		assertEmptyReply(t, code, out)
	}
}

func TestNilStdin(t *testing.T) {
	code, out := run(t, nil, nil, noEnv)
	assertEmptyReply(t, code, out)
}

func TestBackgroundRunDoesNothing(t *testing.T) {
	env := func(k string) string {
		if k == "MEX_BACKGROUND" {
			return "1"
		}
		return ""
	}
	code, out := run(t, nil, strings.NewReader(`{"hook_event_name":"UserPromptSubmit"}`), env)
	assertEmptyReply(t, code, out)
}

type errReader struct{}

func (errReader) Read([]byte) (int, error) { return 0, errors.New("read failed") }

func TestReadErrorFailsOpen(t *testing.T) {
	code, out := run(t, nil, errReader{}, noEnv)
	assertEmptyReply(t, code, out)
}

type panicReader struct{}

func (panicReader) Read([]byte) (int, error) { panic("boom") }

func TestPanicInEnvFailsOpen(t *testing.T) {
	env := func(string) string { panic("boom") }
	code, out := run(t, nil, strings.NewReader("{}"), env)
	assertEmptyReply(t, code, out)
}

type blockingReader struct{ unblock chan struct{} }

func (b blockingReader) Read([]byte) (int, error) {
	<-b.unblock
	return 0, io.EOF
}

func TestOpenStdinTimesOut(t *testing.T) {
	r := blockingReader{make(chan struct{})}
	defer close(r.unblock)
	start := time.Now()
	_, ok := readPayload(r, 50*time.Millisecond)
	if ok {
		t.Fatal("expected the read to give up")
	}
	if d := time.Since(start); d > time.Second {
		t.Fatalf("read took %v, want it to stop at the timeout", d)
	}
}

func TestOversizedPayloadIsDrained(t *testing.T) {
	big := strings.NewReader(strings.Repeat("x", maxPayload+1024))
	data, ok := readPayload(big, time.Second)
	if ok {
		t.Fatal("oversized payload should be reported as not ok")
	}
	if len(data) != maxPayload {
		t.Fatalf("read %d bytes, want %d", len(data), maxPayload)
	}
	if big.Len() != 0 {
		t.Fatalf("%d bytes left unread", big.Len())
	}
}

func TestSelfTest(t *testing.T) {
	code, out := run(t, []string{"--self-test"}, nil, noEnv)
	if code != 0 {
		t.Fatalf("exit code = %d", code)
	}
	var res selfTestResult
	if err := json.Unmarshal([]byte(out), &res); err != nil {
		t.Fatalf("self-test output %q: %v", out, err)
	}
	if !res.OK || res.Error != "" {
		t.Fatalf("self-test failed: %+v", res)
	}
}

func TestVersion(t *testing.T) {
	_, out := run(t, []string{"--version"}, nil, noEnv)
	if strings.TrimSpace(out) != Version {
		t.Fatalf("version = %q, want %q", out, Version)
	}
}
