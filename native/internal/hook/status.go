package hook

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/mex-memory/mex/native/internal/adapter"
	localrecord "github.com/mex-memory/mex/native/record"
)

type agentStatus struct {
	Agent string `json:"agent"`
	// HooksOff lists the settings that stop this agent running MEX's hooks.
	HooksOff []string `json:"hooks_off"`
	// LastHeartbeat is the last time any session of this agent ran a hook.
	LastHeartbeat *string `json:"last_heartbeat"`
	Sessions      int     `json:"sessions"`
}

type statusReport struct {
	Version string        `json:"version"`
	Agents  []agentStatus `json:"agents"`
}

// status prints, per agent with a profile, what MEX can see about whether its
// hooks run: the policy switches that turn them off and the last heartbeat.
// `mex` uses it to say "MEX isn't running in Codex here" and why.
func status(stdout io.Writer, h home, goos string) int {
	report := statusReport{Version: Version, Agents: []agentStatus{}}
	directory := h.recordDirectory()
	var beats map[string]map[string]time.Time
	if directory != "" {
		beats, _ = localrecord.HookHeartbeats(localrecord.Location{Hooks: filepath.Join(directory, "hooks.db")}, time.Now().Add(-heartbeatMaxAge))
	}
	for _, name := range adapter.Agents() {
		s := agentStatus{Agent: name, HooksOff: h.hooksOff(name, goos)}
		if s.HooksOff == nil {
			s.HooksOff = []string{}
		}
		seen := map[string]time.Time{}
		for id, stamp := range beats[name] {
			seen[safeName(id)] = stamp
		}
		files, _ := os.ReadDir(h.heartbeatDir(name))
		for _, f := range files {
			if info, err := f.Info(); err == nil && !info.IsDir() && info.ModTime().After(seen[f.Name()]) {
				seen[f.Name()] = info.ModTime()
			}
		}
		var last time.Time
		for _, stamp := range seen {
			if stamp.After(last) {
				last = stamp
			}
		}
		if n := len(seen); n > 0 {
			ts := last.UTC().Format(time.RFC3339)
			s.LastHeartbeat, s.Sessions = &ts, n
		}
		report.Agents = append(report.Agents, s)
	}
	sort.Slice(report.Agents, func(i, j int) bool { return report.Agents[i].Agent < report.Agents[j].Agent })
	b, _ := json.Marshal(report)
	_, _ = stdout.Write(append(b, '\n'))
	return 0
}
