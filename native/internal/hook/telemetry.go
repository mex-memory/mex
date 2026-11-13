package hook

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	localrecord "github.com/mex-memory/mex/native/record"
)

// hookUsageLocation applies telemetry policy before resolving the shared record
// location. The checkout gate can reuse this validated, read-only result.
func hookUsageLocation(h home, getenv Env) (localrecord.Location, bool) {
	if getenv("DO_NOT_TRACK") == "1" || getenv("MEX_TELEMETRY") == "0" || getenv("MEX_OFFLINE") == "1" || getenv("MEX_DEV") != "" {
		return localrecord.Location{}, false
	}
	for _, key := range []string{"CI", "CONTINUOUS_INTEGRATION", "GITHUB_ACTIONS", "GITLAB_CI", "TF_BUILD", "BUILDKITE", "CIRCLECI", "JENKINS_URL"} {
		value := strings.ToLower(strings.TrimSpace(getenv(key)))
		if value != "" && value != "0" && value != "false" && value != "no" {
			return localrecord.Location{}, false
		}
	}
	if info, err := os.Lstat(h.mex); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return localrecord.Location{}, false
	}
	if _, err := os.Lstat(filepath.Join(h.mex, "telemetry-disabled")); err == nil || !os.IsNotExist(err) {
		return localrecord.Location{}, false
	}
	// Node setup publishes the shared location. Without it, skip rather than
	// probing a network home or creating MEX storage from an otherwise empty hook.
	if info, err := os.Lstat(filepath.Join(h.mex, "location")); err != nil || !info.Mode().IsRegular() || info.Size() > 4096 {
		return localrecord.Location{}, false
	}
	config := filepath.Join(h.mex, "config.json")
	if info, err := os.Lstat(config); err == nil {
		if !info.Mode().IsRegular() || info.Size() > 65536 {
			return localrecord.Location{}, false
		}
		file, err := os.Open(config)
		if err != nil {
			return localrecord.Location{}, false
		}
		bytes, err := io.ReadAll(io.LimitReader(file, 65537))
		file.Close()
		if err != nil || len(bytes) > 65536 || !utf8.Valid(bytes) {
			return localrecord.Location{}, false
		}
		var values map[string]json.RawMessage
		if json.Unmarshal(bytes, &values) != nil || values == nil {
			return localrecord.Location{}, false
		}
		if value, ok := values["telemetry"]; ok && string(value) != `"on"` {
			return localrecord.Location{}, false
		}
	} else if !os.IsNotExist(err) {
		return localrecord.Location{}, false
	}
	location, err := localrecord.ResolveLocation(localrecord.LocationOptions{Home: h.mex, ReadOnly: true})
	if err != nil {
		return localrecord.Location{}, false
	}
	return location, true
}

// Hooks only count. They never create an analytics identity, send, start a model
// or wait for the background process. Every storage error is ignored.
func recordHookUsage(location localrecord.Location, agent string, sessionStart, failed bool, elapsed time.Duration) {
	for _, file := range []string{location.Hooks, location.Hooks + "-wal", location.Hooks + "-shm"} {
		if !safeTelemetryFile(file) {
			return
		}
	}
	hooks, err := localrecord.OpenHookCounters(location)
	if err != nil {
		return
	}
	defer hooks.Close()
	_ = hooks.RecordHookUsage(time.Now().UTC().Format("2006-01-02"), agent, sessionStart, failed, elapsed.Milliseconds())
}
