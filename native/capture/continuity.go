package capture

import (
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/record/place"
)

// ContinuityTTL is how long 'where we left off' waits for the next session.
const ContinuityTTL = 14 * 24 * time.Hour

// Continuity is the per-branch snapshot behind 'where we left off' (sheet
// 22). The hooks keep it current; it holds no AI output. It is personal: it
// lives in the record directory, never in the repo.
type Continuity struct {
	Version     int       `json:"version"`
	ProjectID   string    `json:"project_id"`
	Checkout    string    `json:"checkout"`
	Branch      string    `json:"branch"`
	Head        string    `json:"head"`
	Session     string    `json:"session"`
	Agent       string    `json:"agent"`
	Updated     string    `json:"updated"`
	LastAsk     string    `json:"last_ask,omitempty"`
	LastFailure *Failure  `json:"last_failure,omitempty"`
	NextSession []string  `json:"next_session,omitempty"` // items the filter labels next-session (learning-02)
	updatedAt   time.Time `json:"-"`
}

// Failure is a command that failed and hasn't passed since.
type Failure struct {
	Command string `json:"command"`
	Exit    int    `json:"exit"`
}

const (
	maxAsk     = 160
	maxFailCmd = 120
)

// ContinuityPath is <record dir>/continuity/<hash of checkout and branch>.json.
func ContinuityPath(recordDirectory, checkout, branch string) string {
	return filepath.Join(recordDirectory, "continuity", place.ShortHash(checkout+"\x00"+branch)+".json")
}

// ReadContinuity reads the snapshot for a checkout's branch.
func ReadContinuity(recordDirectory, checkout, branch string) (Continuity, bool) {
	var c Continuity
	if err := readJSON(ContinuityPath(recordDirectory, checkout, branch), &c); err != nil || c.Version != 1 || c.Branch != branch || c.Checkout != checkout {
		return Continuity{}, false
	}
	t, err := time.Parse(time.RFC3339, c.Updated)
	if err != nil {
		return Continuity{}, false
	}
	c.updatedAt = t
	return c, true
}

// oneLine flattens text to its first non-empty line, bounded.
func oneLine(text string, max int) string {
	for _, line := range strings.Split(text, "\n") {
		if line = strings.Join(strings.Fields(line), " "); line != "" {
			if utf8.RuneCountInString(line) > max {
				r := []rune(line)
				line = string(r[:max-1]) + "…"
			}
			return line
		}
	}
	return ""
}

// keepContinuity updates the snapshot from a prompt or a command result.
func keepContinuity(ev contract.Event, env Env) error {
	if ev.AgentID != "" || ev.Checkout == "" {
		return nil
	}
	var ask string
	var failure *Failure
	passed := ""
	switch ev.Kind {
	case contract.Prompt:
		if ev.Prompt == nil || Scripted(ev.Agent, env.getenv) {
			return nil
		}
		if ask = oneLine(Redact(ev.Prompt.Text), maxAsk); ask == "" {
			return nil
		}
	case contract.PostTool, contract.PostToolFailure:
		t := ev.Tool
		if t == nil || t.Name != contract.ToolShell {
			return nil
		}
		code := ExitCode(ev, t)
		if code == nil {
			return nil
		}
		command := oneLine(Redact(t.Input.Command), maxFailCmd)
		if *code != 0 {
			failure = &Failure{Command: command, Exit: *code}
		} else {
			passed = command
		}
	default:
		return nil
	}
	branch := Branch(ev.Checkout)
	if branch == "" {
		return nil
	}
	c, ok := ReadContinuity(env.RecordDirectory, ev.Checkout, branch)
	if !ok || c.Session != ev.SessionID {
		if passed != "" {
			return nil // a pass alone says nothing about where we left off
		}
		c = Continuity{Version: 1, ProjectID: ev.ProjectID, Checkout: ev.Checkout, Branch: branch, Session: ev.SessionID, Agent: ev.Agent}
	}
	switch {
	case ask != "":
		c.LastAsk = ask
	case failure != nil:
		c.LastFailure = failure
	case c.LastFailure != nil && c.LastFailure.Command == passed:
		c.LastFailure = nil
	default:
		return nil
	}
	c.Head = Head(ev.Checkout, branch)
	c.Updated = now(env).UTC().Format(time.RFC3339)
	return writeJSON(ContinuityPath(env.RecordDirectory, ev.Checkout, branch), c)
}

// Carry is a block for the person's next session on the branch.
type Carry struct {
	EntryID  string // the delivery marker: outside the mx_ namespace
	NoticeID string // shown once per machine
	Text     string
	Tokens   int
}

// ContinuityCarry builds 'where we left off' for a new session (not a
// resume) on the same branch, or reports why there is none. A snapshot that
// has expired, whose branch merged, or whose work a later commit cleaned up
// is deleted.
func ContinuityCarry(ev contract.Event, env Env) (Carry, bool) {
	if ev.AgentID != "" || ev.Checkout == "" || ev.SessionID == "" {
		return Carry{}, false
	}
	branch := Branch(ev.Checkout)
	if branch == "" {
		return Carry{}, false
	}
	c, ok := ReadContinuity(env.RecordDirectory, ev.Checkout, branch)
	if !ok || c.Session == ev.SessionID {
		return Carry{}, false
	}
	path := ContinuityPath(env.RecordDirectory, ev.Checkout, branch)
	if now(env).Sub(c.updatedAt) > ContinuityTTL {
		_ = removeFile(path)
		return Carry{}, false
	}
	head := Head(ev.Checkout, branch)
	if Merged(ev.Checkout, branch, head) {
		_ = removeFile(path)
		return Carry{}, false
	}
	names, total, gitOK := Uncommitted(ev.Checkout, 4)
	if gitOK && total == 0 && head != "" && head != c.Head {
		_ = removeFile(path) // a later commit left the tree clean
		return Carry{}, false
	}
	if c.LastAsk == "" && c.LastFailure == nil && total == 0 && len(c.NextSession) == 0 {
		return Carry{}, false
	}
	var b strings.Builder
	b.WriteString("Where the person left off on " + branch + " (last active " + c.updatedAt.UTC().Format("2 Jan") + "; personal, from their own session, not verified):")
	if c.LastAsk != "" {
		b.WriteString("\n- Their last ask: \"" + c.LastAsk + "\"")
	}
	if c.LastFailure != nil {
		b.WriteString("\n- Last failing command: `" + c.LastFailure.Command + "` (exit " + strconv.Itoa(c.LastFailure.Exit) + ")")
	}
	if total > 0 {
		b.WriteString("\n- Uncommitted: " + strings.Join(names, ", "))
		if total > len(names) {
			b.WriteString(" and " + strconv.Itoa(total-len(names)) + " more")
		}
	}
	for i, item := range c.NextSession {
		if i == 3 {
			break
		}
		b.WriteString("\n- Next session: " + oneLine(item, maxAsk))
	}
	text := b.String()
	return Carry{EntryID: "mex:continuity", NoticeID: "continuity:" + place.ShortHash(c.Session+"\x00"+c.Checkout+"\x00"+branch+"\x00"+c.Updated), Text: text, Tokens: Tokens(text)}, true
}

// Tokens estimates tokens as one per four bytes, rounded up.
func Tokens(text string) int { return (len(text) + 3) / 4 }
