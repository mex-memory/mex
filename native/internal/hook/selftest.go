package hook

import (
	"bytes"
	"encoding/json"
	"io"
	"runtime"
	"strings"
)

type selfTestResult struct {
	OK      bool   `json:"ok"`
	Version string `json:"version"`
	OS      string `json:"os"`
	Arch    string `json:"arch"`
	Error   string `json:"error,omitempty"`
}

// selfTest proves the binary can start, read a payload and answer on this
// machine. Installers run it before registering the shim with an agent.
func selfTest(stdout io.Writer) int {
	res := selfTestResult{Version: Version, OS: runtime.GOOS, Arch: runtime.GOARCH}

	var out bytes.Buffer
	payload := strings.NewReader(`{"hook_event_name":"PreToolUse","session_id":"self-test"}`)
	Run(nil, payload, &out, io.Discard, func(string) string { return "" })

	var reply map[string]any
	if err := json.Unmarshal(out.Bytes(), &reply); err != nil {
		res.Error = "reply is not valid JSON"
	} else if len(reply) != 0 {
		res.Error = "no-op call did not return the empty reply"
	} else {
		res.OK = true
	}

	enc, _ := json.Marshal(res)
	_, _ = stdout.Write(append(enc, '\n'))
	return 0
}
