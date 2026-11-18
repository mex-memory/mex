package adapter

import "encoding/json"

// Agents read each other's hook files: Cursor runs Claude Code's hooks by
// default, Copilot CLI reads project .claude hooks, and Devin reads ~/.claude.
// Detect names the agent actually running a hook so the shim can answer in its
// format, or stay quiet.
//
// Only the payload is used. Environment variables are inherited: an agent
// started from another agent's terminal carries that agent's variables.

// PayloadSignals are keys only one agent's payloads carry, checked in order.
var PayloadSignals = []struct {
	Agent string
	Keys  []string // any one present
}{
	{Agent: "cursor", Keys: []string{"cursor_version", "generation_id"}},
	{Agent: "copilot", Keys: []string{"toolName", "toolArgs"}},
	{Agent: "codex", Keys: []string{"turn_id"}},
}

// Detect returns the agent whose payload this is, or "" when no signal matches.
// "" means "trust the agent the hook was registered for".
func Detect(payload []byte) string {
	var keys map[string]json.RawMessage
	if json.Unmarshal(payload, &keys) != nil {
		return ""
	}
	for _, s := range PayloadSignals {
		for _, k := range s.Keys {
			if _, ok := keys[k]; ok {
				return s.Agent
			}
		}
	}
	return ""
}
