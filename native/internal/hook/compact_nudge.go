package hook

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/mex-memory/mex/native/capture"
	"github.com/mex-memory/mex/native/delivery/rank"
	"github.com/mex-memory/mex/native/internal/contract"
)

// A short follow-up or a pasted tool result is too weak a topic signal.
// Keep a few hashed terms from a substantive prompt in the same checkout.
func compactNudge(ev contract.Event, h home, state *leverState) string {
	if ev.AgentID != "" || ev.Checkout == "" || ev.Prompt == nil || !ev.Prompt.Typed ||
		capture.Scripted(ev.Agent, h.env) || capture.Pasted(ev.Prompt.Text) || rank.Machine(ev.Prompt.Text) {
		return ""
	}
	var root, command string
	switch ev.Agent {
	case "claude-code":
		if h.claude == "" {
			return ""
		}
		root, command = filepath.Join(h.claude, "projects"), "/clear"
	case "codex":
		if h.codex == "" {
			return ""
		}
		root, command = filepath.Join(h.codex, "sessions"), "/new"
	default:
		return ""
	}
	var topic []uint64
	for _, term := range rank.Tokens(ev.Prompt.Text) {
		hash := wordHash(term)
		if !slices.Contains(topic, hash) {
			topic = append(topic, hash)
		}
		if len(topic) == 32 {
			break
		}
	}
	if len(topic) < 4 {
		return ""
	}
	previous := state.Topic
	sameCheckout := state.TopicCheckout == ev.Checkout
	state.Topic, state.TopicCheckout = topic, ev.Checkout
	if state.CompactNudged || !sameCheckout || len(previous) < 4 ||
		slices.ContainsFunc(topic, func(term uint64) bool { return slices.Contains(previous, term) }) {
		return ""
	}
	if tokens := currentContext(root, ev); tokens > 250_000 {
		state.CompactNudged = true
		return fmt.Sprintf("Context is about %dk tokens. Starting a new topic? Try %s or /compact before continuing.", tokens/1000, command)
	}
	return ""
}

// Read only a small tail of this session's host transcript. A boundary ahead
// of the last usage event means the old count no longer describes the context.
func currentContext(directory string, ev contract.Event) int {
	path := ev.Transcript
	name := filepath.Base(path)
	if !filepath.IsAbs(path) || safeName(ev.SessionID) != ev.SessionID ||
		(ev.Agent == "claude-code" && name != ev.SessionID+".jsonl") ||
		(ev.Agent == "codex" && !strings.HasSuffix(name, "-"+ev.SessionID+".jsonl")) {
		return 0
	}
	rel, err := filepath.Rel(directory, path)
	if err != nil {
		return 0
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return 0
	}
	defer root.Close()
	expected, err := root.Lstat(rel)
	if err != nil || !expected.Mode().IsRegular() || expected.Size() == 0 {
		return 0
	}
	f, err := root.Open(rel)
	if err != nil {
		return 0
	}
	defer f.Close()
	if info, err := f.Stat(); err != nil || !os.SameFile(expected, info) || info.Size() != expected.Size() {
		return 0
	}
	const limit = 256 << 10
	offset := max(int64(0), expected.Size()-limit)
	tail := make([]byte, expected.Size()-offset)
	if _, err := f.ReadAt(tail, offset); err != nil {
		return 0
	}
	if offset > 0 {
		first := bytes.IndexByte(tail, '\n')
		if first < 0 {
			return 0
		}
		tail = tail[first+1:]
	}
	return contextFromTail(tail, ev.Agent)
}

type contextUsage struct {
	Input *int `json:"input_tokens"`
	Read  int  `json:"cache_read_input_tokens"`
	Write int  `json:"cache_creation_input_tokens"`
}

func contextFromTail(tail []byte, agent string) int {
	end := bytes.LastIndexByte(tail, '\n')
	for end >= 0 {
		start := bytes.LastIndexByte(tail[:end], '\n')
		line := tail[start+1 : end]
		end = start
		if !bytes.Contains(line, []byte(`"input_tokens"`)) && !bytes.Contains(line, []byte(`"compact`)) {
			continue
		}
		var row struct {
			Type, Subtype                                                 string
			IsSidechain, IsSynthetic, IsApiErrorMessage, IsCompactSummary bool
			Message                                                       struct {
				Model string
				Usage contextUsage
			}
			Payload struct {
				Type string
				Info struct {
					Last contextUsage `json:"last_token_usage"`
				}
			}
		}
		if json.Unmarshal(line, &row) != nil || row.IsSidechain || row.IsSynthetic || row.IsApiErrorMessage {
			continue
		}
		var usage contextUsage
		if agent == "claude-code" {
			if row.Type == "system" && row.Subtype == "compact_boundary" {
				return 0
			}
			if row.Type != "assistant" || row.IsCompactSummary || row.Message.Model == "<synthetic>" {
				continue
			}
			usage = row.Message.Usage
		} else {
			if row.Type == "compacted" {
				return 0
			}
			if row.Type != "event_msg" || row.Payload.Type != "token_count" {
				continue
			}
			usage = row.Payload.Info.Last
		}
		if usage.Input != nil && *usage.Input >= 0 && *usage.Input <= 2_000_000 &&
			usage.Read >= 0 && usage.Read <= 2_000_000 && usage.Write >= 0 && usage.Write <= 2_000_000 {
			if tokens := *usage.Input + usage.Read + usage.Write; tokens <= 2_000_000 {
				return tokens
			}
		}
	}
	return 0
}
