package output

import (
	"strings"
)

// Quoting for the Codex wrapper. The hook rewrites a simple command to
//
//	'<mex-hook>' run --shell <shell> -- '<original>'          (bash, zsh, sh)
//	& '<mex-hook>' run --shell powershell -- '<original>'     (Windows)
//
// so the agent's own shell hands the wrapper the exact original text.

// Shells the wrapper runs a command through.
const (
	ShellBash       = "bash"
	ShellZsh        = "zsh"
	ShellSh         = "sh"
	ShellPowerShell = "powershell"
	ShellPwsh       = "pwsh"
)

// KnownShell reports whether the wrapper can run commands through shell.
func KnownShell(shell string) bool {
	switch shell {
	case ShellBash, ShellZsh, ShellSh, ShellPowerShell, ShellPwsh:
		return true
	}
	return false
}

func powerShell(shell string) bool { return shell == ShellPowerShell || shell == ShellPwsh }

// QuotePOSIX makes one single-quoted word for bash, zsh and sh.
func QuotePOSIX(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// QuotePowerShell makes one single-quoted PowerShell string. PowerShell also
// reads the typographic single quotes as quotes, so they are doubled too.
func QuotePowerShell(s string) string {
	var b strings.Builder
	b.WriteByte('\'')
	for _, r := range s {
		switch r {
		case '\'', '‘', '’', '‚', '‛':
			b.WriteRune(r)
		}
		b.WriteRune(r)
	}
	b.WriteByte('\'')
	return b.String()
}

// Wrap builds the command line that runs original through the wrapper.
func Wrap(binary, shell, original string) string {
	if powerShell(shell) {
		return "& " + QuotePowerShell(binary) + " run --shell " + shell + " -- " + QuotePowerShell(original)
	}
	return QuotePOSIX(binary) + " run --shell " + shell + " -- " + QuotePOSIX(original)
}

// Unwrap returns the original command of a wrapper command line, so what the
// agent ran is seen as itself after it ran. ok is false for anything else.
func Unwrap(command string) (original string, shell string, ok bool) {
	rest := command
	ps := strings.HasPrefix(rest, "& ")
	if ps {
		rest = rest[2:]
	}
	binary, rest, ok := cutQuoted(rest, ps)
	if !ok || binary == "" {
		return "", "", false
	}
	rest, ok = strings.CutPrefix(rest, " run --shell ")
	if !ok {
		return "", "", false
	}
	shell, rest, ok = strings.Cut(rest, " -- ")
	if !ok || !KnownShell(shell) || powerShell(shell) != ps {
		return "", "", false
	}
	original, rest, ok = cutQuoted(rest, ps)
	if !ok || rest != "" {
		return "", "", false
	}
	return original, shell, true
}

// cutQuoted reads one single-quoted word at the start of s, the way the
// wrapper wrote it, and returns its value and what follows.
func cutQuoted(s string, ps bool) (string, string, bool) {
	if ps {
		return cutPowerShellQuoted(s)
	}
	// POSIX: '…' words joined by \' (the '\'' idiom).
	var b strings.Builder
	i := 0
	for {
		if i >= len(s) || s[i] != '\'' {
			return "", "", false
		}
		end := strings.IndexByte(s[i+1:], '\'')
		if end < 0 {
			return "", "", false
		}
		b.WriteString(s[i+1 : i+1+end])
		i += end + 2
		if strings.HasPrefix(s[i:], `\''`) {
			b.WriteByte('\'')
			i += 2
			continue
		}
		return b.String(), s[i:], true
	}
}

func isPSQuote(r rune) bool { return r == '\'' || r == '‘' || r == '’' || r == '‚' || r == '‛' }

func cutPowerShellQuoted(s string) (string, string, bool) {
	runes := []rune(s)
	if len(runes) == 0 || !isPSQuote(runes[0]) {
		return "", "", false
	}
	var b strings.Builder
	for i := 1; i < len(runes); i++ {
		if isPSQuote(runes[i]) {
			if i+1 < len(runes) && isPSQuote(runes[i+1]) {
				b.WriteRune(runes[i])
				i++
				continue
			}
			return b.String(), string(runes[i+1:]), true
		}
		b.WriteRune(runes[i])
	}
	return "", "", false
}
