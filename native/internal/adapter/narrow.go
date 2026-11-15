package adapter

import "github.com/mex-memory/mex/native/internal/contract"

// Narrow removes the parts of a reply that a profile can't carry for one
// kind, and names them in contract order. Profiles added after Claude Code and
// Codex render from the narrowed reply, so "what works where" lives only in
// their Capabilities.
func Narrow(c Capabilities, kind contract.Kind, r contract.Reply) (contract.Reply, []string) {
	s, ok := c.Support(kind)
	if !ok {
		return contract.Reply{}, nil
	}
	var dropped []string
	if r.ConsumePrompt && !(kind == contract.Prompt && s.ConsumePrompt) {
		r.ConsumePrompt = false
		dropped = append(dropped, "consume_prompt")
	}
	if r.Context != "" && s.Context == ChannelNone {
		r.Context = ""
		dropped = append(dropped, "context")
	}
	if r.Decision == contract.Deny && !s.Deny {
		r.Decision, r.Reason = "", ""
		dropped = append(dropped, "decision")
	}
	if r.ReplaceInput != nil && !s.ReplaceInput {
		r.ReplaceInput = nil
		dropped = append(dropped, "replace_input")
	}
	if r.ReplaceOutput != nil && !s.ReplaceOutput {
		r.ReplaceOutput = nil
		dropped = append(dropped, "replace_output")
	}
	if r.PersonLine != "" && !s.PersonLine {
		r.PersonLine = ""
		dropped = append(dropped, "person_line")
	}
	return r, dropped
}
