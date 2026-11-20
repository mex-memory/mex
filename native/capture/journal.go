// Package capture saves what a person typed, what commands returned and which
// files the agent edited, and nothing else (plan sheets 21-23). The prompt
// hook saves typed text before the reply starts, so an interrupt or a
// terminal closed mid-reply loses nothing. Tool hooks save the command and its
// exit code, or an edited file's repo-relative path: never agent text, file
// contents or tool output.
//
// Everything here fails open. A capture that can't be saved is skipped; the
// agent call always goes on.
package capture

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/internal/safefile"
	"github.com/mex-memory/mex/native/internal/shellparse"
	"github.com/mex-memory/mex/native/record"
	"github.com/mex-memory/mex/native/record/place"
)

const (
	// MaxTyped bounds one typed row. The filter reads at most 1,200
	// characters a message (sheet 21); the rest is kept for the person's last
	// ask and to keep a long paste recognisable as one.
	MaxTyped = 8 << 10
	// MaxCommand bounds one command row.
	MaxCommand = 2 << 10
	// MaxEditPath bounds one edit row. A longer path is skipped, never cut.
	MaxEditPath = 1 << 10
	// maxEditRows bounds the files one tool call records (a large patch).
	maxEditRows = 64
)

// Env is what capture needs from the hook.
type Env struct {
	RecordDirectory string
	Now             time.Time
	Getenv          func(string) string
}

func (e Env) getenv(k string) string {
	if e.Getenv == nil {
		return ""
	}
	return e.Getenv(k)
}

// Rows turns one event into journal rows. Only the main agent types;
// subagents type nothing, and their commands and edits are left out too so a
// subagent's failure is never the person's "last failing command".
func Rows(ev contract.Event, env Env) []record.JournalRow {
	if ev.AgentID != "" {
		return nil
	}
	switch ev.Kind {
	case contract.Prompt:
		if ev.Prompt == nil || strings.TrimSpace(ev.Prompt.Text) == "" {
			return nil
		}
		text := Redact(ev.Prompt.Text)
		return []record.JournalRow{{Kind: "typed", Text: clip(text, MaxTyped), Marks: Marks(ev, env.getenv)}}
	case contract.PostTool, contract.PostToolFailure:
		if row, ok := commandRow(ev, ev.Tool); ok {
			return []record.JournalRow{row}
		}
		return editRows(ev)
	}
	return nil
}

// editRows records the files a successful edit, write or patch changed, as
// paths relative to the session's checkout. Files outside it are left out.
// Like commands, they come from per-call events only, never from a batch.
func editRows(ev contract.Event) []record.JournalRow {
	t := ev.Tool
	if ev.Kind != contract.PostTool || t == nil || t.Output == nil || !t.Output.OK || t.Output.Interrupted || ev.Checkout == "" {
		return nil
	}
	var paths []string
	switch t.Name {
	case contract.ToolEdit, contract.ToolWrite:
		paths = []string{t.Input.Path}
	case contract.ToolPatch:
		for _, f := range t.Input.Files {
			paths = append(paths, f.Path)
		}
	case contract.ToolOther:
		paths = claudeEditPaths(ev, t)
	}
	var out []record.JournalRow
	seen := map[string]bool{}
	for _, p := range paths {
		rel, ok := checkoutRelative(ev.Checkout, p)
		if !ok || seen[rel] || len(rel) > MaxEditPath || !utf8.ValidString(rel) || HasSecret(rel) {
			continue
		}
		seen[rel] = true
		out = append(out, record.JournalRow{Kind: "edit", Text: rel})
		if len(out) == maxEditRows {
			break
		}
	}
	return out
}

// claudeEditPaths reads Claude Code edit tools the contract has no name for:
// MultiEdit (file_path) and NotebookEdit (notebook_path).
func claudeEditPaths(ev contract.Event, t *contract.Tool) []string {
	if ev.Agent != "claude-code" || (t.RawName != "MultiEdit" && t.RawName != "NotebookEdit") || len(t.RawInput) == 0 {
		return nil
	}
	var in struct {
		FilePath     string `json:"file_path"`
		NotebookPath string `json:"notebook_path"`
	}
	if json.Unmarshal(t.RawInput, &in) != nil {
		return nil
	}
	p := in.FilePath
	if t.RawName == "NotebookEdit" {
		p = in.NotebookPath
	}
	if p == "" {
		return nil
	}
	return []string{shellparse.Resolve(ev.Cwd, p)}
}

// checkoutRelative is p relative to the checkout, slash-separated. The plain
// comparison usually settles it; links and OS aliases (macOS /var, Windows
// short names) are resolved only when it doesn't.
func checkoutRelative(checkout, p string) (string, bool) {
	if p == "" {
		return "", false
	}
	if rel, ok := plainRelative(checkout, p); ok {
		return rel, true
	}
	real, err := place.RealPath(checkout)
	if err != nil {
		return "", false
	}
	// Resolve the nearest existing ancestor: a deleted or moved file, or one
	// in a folder that no longer exists, still maps through OS aliases.
	dir, rest := filepath.FromSlash(p), []string{}
	for {
		if resolved, err := place.RealPath(dir); err == nil {
			return plainRelative(real, filepath.Join(append([]string{resolved}, rest...)...))
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		rest = append([]string{filepath.Base(dir)}, rest...)
		dir = parent
	}
	return "", false
}

func plainRelative(checkout, p string) (string, bool) {
	native := filepath.FromSlash(p)
	if !filepath.IsAbs(native) {
		return "", false
	}
	rel, err := filepath.Rel(filepath.FromSlash(checkout), native)
	if err != nil {
		return "", false
	}
	rel = filepath.ToSlash(rel)
	if rel == "." || rel == ".." || strings.HasPrefix(rel, "../") || filepath.IsAbs(rel) {
		return "", false
	}
	return rel, true
}

func commandRow(ev contract.Event, t *contract.Tool) (record.JournalRow, bool) {
	if t == nil || t.Name != contract.ToolShell || strings.TrimSpace(t.Input.Command) == "" {
		return record.JournalRow{}, false
	}
	// Claude Code sends PostToolUse per call and PostToolBatch per batch;
	// commands are taken from the per-call events only, never twice.
	return record.JournalRow{Kind: "command", Text: clip(Redact(strings.TrimSpace(t.Input.Command)), MaxCommand), ExitCode: ExitCode(ev, t)}, true
}

// ExitCode is the command's exit code when the agent says it, else nil.
// Claude Code reports success on PostToolUse and the code on failure; Codex
// gives a code only when its output carries an "Exit code:" header.
func ExitCode(ev contract.Event, t *contract.Tool) *int {
	if t == nil || t.Output == nil {
		return nil
	}
	if t.Output.ExitCode != nil {
		c := *t.Output.ExitCode
		return &c
	}
	if ev.Kind == contract.PostTool && ev.Agent == "claude-code" && t.Output.OK {
		zero := 0
		return &zero
	}
	return nil
}

// Marks says when typed text doesn't count as "a person said it": pasted
// text, and prompts from scripts or CI. Accepted suggestions aren't in any
// hook payload today, so they can't be marked yet.
func Marks(ev contract.Event, getenv func(string) string) string {
	pasted := ev.Prompt != nil && (!ev.Prompt.Typed || Pasted(ev.Prompt.Text))
	scripted := Scripted(ev.Agent, getenv)
	switch {
	case pasted && scripted:
		return "pasted,scripted"
	case pasted:
		return "pasted"
	case scripted:
		return "scripted"
	}
	return ""
}

// Scripted reports a prompt sent by a script, an SDK or CI. Claude Code marks
// its SDK entry points (sheet 22: "Claude marks them sdk"); CI runners set CI.
func Scripted(agent string, getenv func(string) string) bool {
	if getenv == nil {
		return false
	}
	if v := strings.ToLower(getenv("CI")); v != "" && v != "0" && v != "false" {
		return true
	}
	for _, k := range []string{"GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "JENKINS_URL", "TF_BUILD"} {
		if getenv(k) != "" {
			return true
		}
	}
	if agent == "claude-code" && strings.HasPrefix(strings.ToLower(getenv("CLAUDE_CODE_ENTRYPOINT")), "sdk") {
		return true
	}
	return false
}

// Patterns compile on first use: this package is linked into the hook shim,
// which would otherwise pay for every compile on each start.
var (
	stackLine = sync.OnceValue(func() *regexp.Regexp {
		return regexp.MustCompile(`(?m)^(?:\s+at .+\(.+:\d+(?::\d+)?\)|\s+at [\w.$<>]+ \(|\s*File ".+", line \d+|Traceback \(most recent call last\):|diff --git |@@ -\d+(?:,\d+)? \+\d+|\s*--> .+:\d+:\d+|.+:\d+:\d+: (?:error|warning)\b)`)
	})
	logLine = sync.OnceValue(func() *regexp.Regexp { return regexp.MustCompile(`(?m)^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}`) })
)

// Pasted reports text that looks pasted rather than typed: long text, many
// lines, or the shapes of logs, stack traces and diffs. Hosts don't say
// whether text was pasted, so this is a starting heuristic (plan values are
// tuned by learning-02's tests); a miss only means the filter weighs it as
// typed.
func Pasted(text string) bool {
	if utf8.RuneCountInString(text) > 1500 {
		return true
	}
	lines := strings.Count(text, "\n") + 1
	if lines >= 20 {
		return true
	}
	if len(stackLine().FindAllStringIndex(text, 3)) >= 2 || len(logLine().FindAllStringIndex(text, 3)) >= 3 {
		return true
	}
	// A fenced block of five or more lines.
	if i := strings.Index(text, "```"); i >= 0 {
		if j := strings.Index(text[i+3:], "```"); j >= 0 && strings.Count(text[i:i+3+j], "\n") >= 6 {
			return true
		}
	}
	return false
}

type secretPattern struct {
	re   *regexp.Regexp
	repl string
}

// Mirrors src/knowledge/gates.ts SECRETS, plus MEX's own producer tokens, so
// both sides hold the same line.
var secretPatterns = sync.OnceValue(func() []secretPattern {
	return []secretPattern{
		{regexp.MustCompile(`-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)`), Redacted},
		{regexp.MustCompile(`\b(?:AKIA|ASIA)[A-Z0-9]{16}\b`), Redacted},
		{regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|mexi_[A-Za-z0-9_-]{8,})`), Redacted},
		// A secret's name may carry a prefix: DB_PASSWORD, STRIPE_API_KEY, GITHUB_TOKEN.
		{regexp.MustCompile(`(?i)\b((?:[A-Za-z0-9]+_)*(?:api[_ -]?key|secret[_ -]?key|private[_ -]?key|signing[_ -]?key|access[_ -]?token|auth[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password|passwd|pgpassword|pwd|authorization|secret|token|credentials?)\s*[:=]\s*["']?(?:Bearer\s+)?)[A-Za-z0-9_+/.=-]{8,}`), "${1}" + Redacted},
		{regexp.MustCompile(`(?i)\b(Bearer\s+)[A-Za-z0-9_+/.=-]{16,}`), "${1}" + Redacted},
		// A password in a URL of any scheme: https, postgres, redis, amqp.
		{regexp.MustCompile(`(?i)\b([a-z][a-z0-9+.-]*://[^\s/@:]*:)[^\s/@]+@`), "${1}" + Redacted + "@"},
	}
})

// Redacted replaces each secret.
const Redacted = "[secret removed]"

// Redact replaces anything that looks like a secret. The row is kept, so the
// person's last ask survives, but the secret never reaches the disk.
func Redact(text string) string {
	for _, p := range secretPatterns() {
		text = p.re.ReplaceAllString(text, p.repl)
	}
	return text
}

// HasSecret reports text Redact would change.
func HasSecret(text string) bool { return Redact(text) != text }

func clip(s string, max int) string {
	if len(s) <= max {
		return s
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return s[:cut]
}

// Save writes the event's rows to the journal. Errors are returned for tests;
// the hook ignores them.
func Save(ev contract.Event, env Env) error {
	rows := Rows(ev, env)
	if len(rows) == 0 || ev.SessionID == "" || env.RecordDirectory == "" {
		return nil
	}
	h, err := openHooks(env.RecordDirectory)
	if err != nil {
		return err
	}
	defer h.Close()
	return h.AppendJournal(record.Session{SessionID: ev.SessionID, Agent: ev.Agent, ProjectID: ev.ProjectID, Checkout: ev.Checkout}, now(env).UTC().Format(time.RFC3339Nano), rows)
}

func now(env Env) time.Time {
	if env.Now.IsZero() {
		return time.Now()
	}
	return env.Now
}

func openHooks(directory string) (*record.Hooks, error) {
	for _, name := range []string{"hooks.db", "hooks.db-wal", "hooks.db-shm"} {
		if !safefile.Regular(filepath.Join(directory, name)) {
			return nil, errRedirected
		}
	}
	return record.OpenHooks(record.Location{Directory: directory, Hooks: filepath.Join(directory, "hooks.db")})
}

type captureError string

func (e captureError) Error() string { return string(e) }

const errRedirected = captureError("redirected hooks database")

// SessionStart enforces journal retention (90 days or 200 MB, oldest first)
// in bounded steps. What the filter consumed stays: Node's journal.consumed
// setting is only its cursor, and a later import reads past sessions.
func SessionStart(ev contract.Event, env Env) error {
	if ev.AgentID != "" || ev.ProjectID == "" || env.RecordDirectory == "" {
		return nil
	}
	h, err := openHooks(env.RecordDirectory)
	if err != nil {
		return err
	}
	defer h.Close()
	_, err = h.TrimJournal(now(env))
	return err
}

// Hook is the capture step of one hook call: prune at session start, save the
// journal rows, and keep the continuity and strict-hint state. It never fails
// the call.
func Hook(ev contract.Event, env Env) {
	if ev.SessionID == "" || ev.ProjectID == "" || env.RecordDirectory == "" {
		return
	}
	if ev.Kind == contract.SessionStart {
		_ = SessionStart(ev, env)
		prunePending(env)
		if ev.Source != "compact" {
			pruneCompactionRecovery(env)
		}
	}
	_ = Save(ev, env)
	_ = filterMetadata(ev, env)
	_ = keepContinuity(ev, env)
	_ = track(ev, env, func(session, entryID string) bool {
		h, err := openHooks(env.RecordDirectory)
		if err != nil {
			return true // unknown counts as delivered: never promote on doubt
		}
		defer h.Close()
		given, err := h.Delivered(session, entryID)
		return err != nil || given
	})
}

// prunePending drops strict-rule state left by sessions that ended mid-pair.
func prunePending(env Env) {
	dir := filepath.Join(env.RecordDirectory, "capture-pending")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	cutoff := now(env).Add(-48 * time.Hour)
	for i, e := range entries {
		if i >= 1024 {
			return
		}
		if info, err := e.Info(); err == nil && info.Mode().IsRegular() && info.ModTime().Before(cutoff) {
			_ = os.Remove(filepath.Join(dir, e.Name()))
		}
	}
}
