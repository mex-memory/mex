// Package adapter defines what every agent profile declares and does: turn the
// agent's hook payload into a contract.Event, and a contract.Reply back into
// output that agent accepts.
package adapter

import (
	"errors"

	"github.com/mex-memory/mex/native/internal/contract"
)

// Channel is where reply context reaches the model.
type Channel string

const (
	// ChannelSystem: shown to the model as a system note next to the turn.
	ChannelSystem Channel = "system"
	// ChannelToolResult: added to the tool result the model reads.
	ChannelToolResult Channel = "tool_result"
	// ChannelUser: shown as if the person said it.
	ChannelUser Channel = "user"
	// ChannelNone: this kind can't carry context in this agent.
	ChannelNone Channel = "none"
)

// KindSupport says what a profile can do for one kind of event.
type KindSupport struct {
	Kind          contract.Kind
	NativeEvent   string  // the agent's own event name
	Context       Channel // where Reply.Context lands
	Deny          bool
	ReplaceInput  bool
	ReplaceOutput bool
	PersonLine    bool
	// TimeoutSeconds is the timeout MEX registers for this hook.
	TimeoutSeconds int
}

// Capabilities is a profile's declaration, as listed in the hook contract.
type Capabilities struct {
	Agent string
	Kinds []KindSupport
	// FailureBlocks: a hook that crashes or times out blocks the agent.
	FailureBlocks bool
	// SubagentID names the payload field that identifies a subagent.
	SubagentID string
	// SettingsFile is the user-level file MEX registers hooks in, relative
	// to the home folder.
	SettingsFile string
	// PolicySwitches are settings that turn hooks off, as "file: key".
	PolicySwitches []string
}

// Support returns what the profile declares for a kind, if anything.
func (c Capabilities) Support(k contract.Kind) (KindSupport, bool) {
	for _, s := range c.Kinds {
		if s.Kind == k {
			return s, true
		}
	}
	return KindSupport{}, false
}

// KindFor maps the agent's event name to a contract kind.
func (c Capabilities) KindFor(nativeEvent string) (contract.Kind, bool) {
	for _, s := range c.Kinds {
		if s.NativeEvent == nativeEvent {
			return s.Kind, true
		}
	}
	return "", false
}

// Command is one registered hook: an executable and its arguments, no shell.
type Command struct {
	Path string
	Args []string
}

type Profile interface {
	Capabilities() Capabilities
	// Parse turns one hook payload into an event. nativeEvent comes from the
	// registered command line, so it is known even when the payload is broken.
	Parse(nativeEvent string, payload []byte) (contract.Event, error)
	// Render turns a reply into the agent's output. Parts the agent can't
	// carry are dropped and named in the second return value; Render never fails.
	Render(ev contract.Event, r contract.Reply) (out []byte, dropped []string)
	// EmptyReply is the output for "do nothing" when there is no usable event.
	EmptyReply(nativeEvent string) []byte
	// Command is the fixed command line registered for one event.
	Command(binary, nativeEvent string) Command
}

var ErrUnknownEvent = errors.New("unknown event")

var registry = map[string]Profile{}

// Register adds a profile. Profiles register themselves in init.
func Register(p Profile) { registry[p.Capabilities().Agent] = p }

// Lookup returns the profile for an agent id such as "claude-code".
func Lookup(agent string) (Profile, bool) {
	p, ok := registry[agent]
	return p, ok
}
