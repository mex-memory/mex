package hook

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/mex-memory/mex/native/capture"
	"github.com/mex-memory/mex/native/internal/contract"
	"github.com/mex-memory/mex/native/internal/shellparse"
	"github.com/mex-memory/mex/native/output"
	localrecord "github.com/mex-memory/mex/native/record"
)

// The Codex wrapper (L4). Codex can't replace a tool's output, so the hook
// rewrites a simple noisy command to run through `mex-hook run`, which runs
// the exact original, prints it first, keeps its exit code and trims its
// output like the Claude Code hook does. Codex accepts a rewritten input only
// together with "allow", so MEX rewrites only commands Codex would have run
// without asking: never one that asks to leave the sandbox, matches one of
// the person's Codex rules, or runs under the "untrusted" approval policy.
// Claude Code's commands are never rewritten.

// wrapCodexCommand runs before a Codex tool call.
func wrapCodexCommand(ev contract.Event, h home, recordDirectory string, state *leverState) contract.Reply {
	t := ev.Tool
	if t.Name != contract.ToolShell || h.levers.raw || state.Investigating {
		return contract.Reply{}
	}
	command := t.Input.Command
	if command == "" || state.Failed[commandKey(command)] || !simpleCommand(command) || !output.Noisy(command) ||
		leverOff(recordDirectory, localrecord.LeverWrapper) {
		return contract.Reply{}
	}
	if leavesSandbox(t.RawInput) || codexAsks(h, ev.Checkout, command) {
		return contract.Reply{}
	}
	shell := codexShell(h)
	binary := h.levers.binary
	if binary == "" {
		binary = selfPath()
	}
	if shell == "" || binary == "" {
		return contract.Reply{}
	}
	return contract.Reply{Decision: contract.Allow, ReplaceInput: &contract.ToolInput{Command: output.Wrap(binary, shell, command)}}
}

var selfPath = sync.OnceValue(func() string {
	p, err := os.Executable()
	if err != nil {
		return ""
	}
	if real, err := filepath.EvalSymlinks(p); err == nil {
		p = real
	}
	return p
})

// simpleCommand: one command with its arguments. No pipes, redirects,
// heredocs, lists or background runs, no substitution, no sudo. Quoted text is
// checked too, which turns away a few safe commands rather than let one
// unsafe one through.
func simpleCommand(command string) bool {
	if strings.TrimSpace(command) == "" || len(command) > 4096 {
		return false
	}
	if strings.ContainsAny(command, "|&;<>\n\r`(){}") || strings.Contains(command, "$(") {
		return false
	}
	words := shellparse.Words(command)
	if len(words) == 0 {
		return false
	}
	for _, w := range words {
		switch strings.ToLower(filepath.Base(strings.ReplaceAll(w, `\`, "/"))) {
		case "sudo", "doas", "su", "runas", "pkexec", "start-process", "mex-hook", "mex-hook.exe":
			return false
		}
	}
	return true
}

// leavesSandbox reports whether Codex's tool input asks for permissions
// beyond the sandbox, in any form Codex has used.
func leavesSandbox(raw json.RawMessage) bool {
	if len(raw) == 0 {
		return false
	}
	var in map[string]json.RawMessage
	if json.Unmarshal(raw, &in) != nil {
		return true
	}
	for key, value := range in {
		v := strings.TrimSpace(string(value))
		switch key {
		case "command", "workdir", "cwd", "timeout_ms", "timeout", "description", "login", "yield_time_ms", "max_output_tokens", "shell", "tty":
		case "sandbox_permissions":
			if v != `"use_default"` && v != `""` && v != "null" {
				return true
			}
		case "with_escalated_permissions":
			if v != "false" && v != "null" {
				return true
			}
		default:
			// justification, prefix_rule and any field MEX doesn't know.
			if v != "null" && v != `""` && v != "false" {
				return true
			}
		}
	}
	return false
}

// codexShell is the shell Codex runs commands through on this machine.
func codexShell(h home) string {
	if runtime.GOOS == "windows" {
		return output.ShellPowerShell
	}
	shell := filepath.Base(h.levers.shell)
	if shell == "" || shell == "." {
		return output.ShellBash
	}
	switch shell {
	case output.ShellBash, output.ShellZsh, output.ShellSh:
		return shell
	}
	return "" // fish and others: their syntax differs, so leave them alone
}

// codexAsks reports whether Codex might ask the person before running
// command: the approval policy is "untrusted", or any of their rules (in
// CODEX_HOME/rules or the project's .codex/rules) names it. A rules file MEX
// can't read counts as asking.
func codexAsks(h home, checkout, command string) bool {
	if h.codex == "" {
		return true
	}
	if policy := tomlValues(filepath.Join(h.codex, "config.toml"))["approval_policy"]; strings.Contains(policy, "untrusted") {
		return true
	}
	words := shellparse.Words(command)
	dirs := []string{filepath.Join(h.codex, "rules")}
	if checkout != "" {
		dirs = append(dirs, filepath.Join(checkout, ".codex", "rules"))
	}
	for _, dir := range dirs {
		files, err := filepath.Glob(filepath.Join(dir, "*.rules"))
		if err != nil {
			return true
		}
		for _, f := range files {
			patterns, ok := readCodexRules(f)
			if !ok {
				return true
			}
			for _, p := range patterns {
				if p.matches(words) {
					return true
				}
			}
		}
	}
	return false
}

// rulePattern is one prefix_rule's pattern: each position lists the words
// it accepts.
type rulePattern [][]string

func (p rulePattern) matches(words []string) bool {
	if len(p) == 0 || len(words) < len(p) {
		return false
	}
	for i, alts := range p {
		ok := false
		for _, a := range alts {
			if a == words[i] || (i == 0 && a == filepath.Base(words[i])) {
				ok = true
				break
			}
		}
		if !ok {
			return false
		}
	}
	return true
}

var (
	ruleCall   = sync.OnceValue(func() *regexp.Regexp { return regexp.MustCompile(`(?s)prefix_rule\s*\(`) })
	patternArg = sync.OnceValue(func() *regexp.Regexp { return regexp.MustCompile(`(?s)\bpattern\s*=\s*\[`) })
	stringLit  = sync.OnceValue(func() *regexp.Regexp { return regexp.MustCompile(`^\s*"((?:[^"\\]|\\.)*)"|^\s*'((?:[^'\\]|\\.)*)'`) })
)

// readCodexRules reads the pattern of every prefix_rule in a .rules file.
// Anything it can't follow makes the whole file unreadable.
func readCodexRules(file string) ([]rulePattern, bool) {
	f, err := os.Open(file)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	data, err := io.ReadAll(io.LimitReader(f, 1<<20))
	if err != nil {
		return nil, false
	}
	text := string(data)
	var out []rulePattern
	for _, loc := range ruleCall().FindAllStringIndex(text, -1) {
		body := text[loc[1]:]
		m := patternArg().FindStringIndex(body)
		if m == nil {
			return nil, false
		}
		pattern, ok := parsePattern(body[m[1]:])
		if !ok {
			return nil, false
		}
		out = append(out, pattern)
	}
	return out, true
}

// parsePattern reads `"a", ["b", "c"], …]` after a pattern's opening bracket.
func parsePattern(s string) (rulePattern, bool) {
	var p rulePattern
	for {
		s = strings.TrimSpace(s)
		switch {
		case strings.HasPrefix(s, "]"):
			return p, len(p) > 0
		case strings.HasPrefix(s, "["):
			s = s[1:]
			var alts []string
			for {
				s = strings.TrimSpace(s)
				if strings.HasPrefix(s, "]") {
					s = s[1:]
					break
				}
				lit, rest, ok := readString(s)
				if !ok {
					return nil, false
				}
				alts = append(alts, lit)
				s = strings.TrimSpace(rest)
				s = strings.TrimPrefix(s, ",")
			}
			if len(alts) == 0 {
				return nil, false
			}
			p = append(p, alts)
		default:
			lit, rest, ok := readString(s)
			if !ok {
				return nil, false
			}
			p = append(p, []string{lit})
			s = rest
		}
		s = strings.TrimSpace(s)
		s = strings.TrimPrefix(s, ",")
	}
}

func readString(s string) (string, string, bool) {
	m := stringLit().FindStringSubmatchIndex(s)
	if m == nil {
		return "", "", false
	}
	var lit string
	if m[2] >= 0 {
		lit = s[m[2]:m[3]]
	} else {
		lit = s[m[4]:m[5]]
	}
	lit = strings.NewReplacer(`\"`, `"`, `\'`, `'`, `\\`, `\`).Replace(lit)
	return lit, s[m[1]:], true
}

// runWrapped is `mex-hook run --shell <shell> -- <command>`.
func runWrapped(args []string, stdin io.Reader, stdout, stderr io.Writer, getenv Env) int {
	if len(args) != 5 || args[1] != "--shell" || !output.KnownShell(args[2]) || args[3] != "--" || args[4] == "" {
		_, _ = io.WriteString(stderr, "usage: mex-hook run --shell <bash|zsh|sh|powershell|pwsh> -- <command>\n")
		return 2
	}
	shell, command := args[2], args[4]
	h := homeFrom(getenv)
	opts := output.RunOptions{Shell: shell, Command: command, Stdin: stdin, Stdout: stdout, Stderr: stderr, Raw: getenv("MEX_RAW") == "1"}
	if h.mexInstalled() && getenv("MEX_OFF") != "1" {
		global := h.controls()
		if global.Off {
			return output.Run(opts)
		}
		if cwd, err := os.Getwd(); err == nil {
			recordDirectory := h.recordDirectory()
			now := time.Now()
			if checkout, where := findCheckout(recordDirectory, cwd, false, now); where == switchedOn && recordDirectory != "" &&
				!leverOff(recordDirectory, localrecord.LeverWrapper) {
				session := getenv("CODEX_THREAD_ID")
				ev := contract.Event{Agent: "codex", SessionID: session, ProjectID: checkout.ProjectID, Checkout: checkout.Root}
				if ledgerHoldout(ev, h, recordDirectory, global.LedgerHoldout, false, now) {
					return output.Run(opts)
				}
				opts.Save = func(text string, code int) (int, error) {
					return output.Save(recordDirectory, checkout.ProjectID, text, output.SavedMeta{
						Command: command, ExitCode: code, Agent: "mex run", SessionID: session}, now)
				}
				if !opts.Raw && session != "" && len(session) <= 256 && output.Noisy(command) && !sessionPaused(recordDirectory, "codex", session) &&
					captureEnabled(recordDirectory, checkout.ProjectID, global) && !capture.Scripted("codex", getenv) {
					opts.Observe = func(before, after int, elapsed time.Duration) {
						recordLeverObservation(ev, h, recordDirectory, time.Now(), elapsed, localrecord.LeverObservation{
							Lever: localrecord.LeverWrapper, Kind: "saving", TokensRemoved: removedTokens(before, after),
							TokensAdded: removedTokens(after, before)})
					}
				}
			}
		}
	}
	return output.Run(opts)
}
