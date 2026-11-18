package capture

import (
	"strings"

	"github.com/mex-memory/mex/native/internal/contract"
)

// MaxNote bounds a typed note; longer text belongs in `mex note`.
const MaxNote = 4 << 10

// NoteCommand recognises a whole prompt that starts with `mex note:` in the
// main session, typed by a person. Pasted or scripted prompts are never notes:
// a script or a pasted log mustn't save a note in the person's name.
func NoteCommand(ev contract.Event, getenv func(string) string) (string, bool) {
	if ev.Kind != contract.Prompt || ev.AgentID != "" || ev.Prompt == nil || !ev.Prompt.Typed || ev.SessionID == "" {
		return "", false
	}
	text := strings.TrimSpace(ev.Prompt.Text)
	const prefix = "mex note:"
	if len(text) < len(prefix) || !strings.EqualFold(text[:len(prefix)], prefix) {
		return "", false
	}
	if Scripted(ev.Agent, getenv) || Pasted(text) {
		return "", false
	}
	body := strings.TrimSpace(text[len(prefix):])
	if body == "" || len(body) > MaxNote || strings.ContainsRune(body, 0) {
		return "", false
	}
	return body, true
}
