package hook

import (
	"bufio"
	"encoding/json"
	"io"
	"time"

	"github.com/mex-memory/mex/native/delivery"
	"github.com/mex-memory/mex/native/internal/contract"
)

// Replay is an explicit, offline controller driver. Its events are already
// normalized by the transcript converter. It never executes recorded tools.
// Timing excludes process startup; cold-process timing uses the normal hook.
func deliveryReplay(stdin io.Reader, stdout io.Writer, getenv Env) int {
	scan := bufio.NewScanner(stdin)
	scan.Buffer(make([]byte, 65536), maxPayload)
	h := homeFrom(getenv)
	enc := json.NewEncoder(stdout)
	for scan.Scan() {
		var ev contract.Event
		if json.Unmarshal(scan.Bytes(), &ev) != nil {
			_ = enc.Encode(map[string]any{"error": true})
			continue
		}
		env := delivery.Environment{Home: h.mex, RecordDirectory: h.recordDirectory(), Now: time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)}
		env.Scorer = getenv("MEX_DELIVERY_SCORER")
		env.Surfaces = getenv("MEX_DELIVERY_SURFACES")
		env.Offline = true
		var phases map[string]int64
		if getenv("MEX_DELIVERY_TRACE") == "1" {
			phases = map[string]int64{}
			env.Trace = func(name string, elapsed time.Duration) { phases[name] += elapsed.Nanoseconds() }
		}
		start := time.Now()
		reply, err := delivery.Handle(ev, env)
		message := ""
		if err != nil {
			reply = contract.Reply{}
			message = err.Error()
		}
		_ = enc.Encode(struct {
			Reply  contract.Reply   `json:"reply"`
			Failed bool             `json:"failed"`
			NS     int64            `json:"ns"`
			Error  string           `json:"error,omitempty"`
			Phases map[string]int64 `json:"phases,omitempty"`
		}{reply, err != nil, time.Since(start).Nanoseconds(), message, phases})
	}
	if scan.Err() != nil {
		return 1
	}
	return 0
}
