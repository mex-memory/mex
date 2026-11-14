package delivery

import (
	"strings"
)

// Commands are matched as words, never as regular expressions: a shell
// command is reduced to the tool and script it runs, so `pnpm run test:unit`,
// `pnpm test:unit` and `npm run test:unit -- --watch` are the same recipe.

// shellSegments splits a command line on the separators an agent uses to
// chain commands. Quoting is respected only for the separators themselves.
func shellSegments(command string) []string {
	var out []string
	var b strings.Builder
	quote := byte(0)
	flush := func() {
		if s := strings.TrimSpace(b.String()); s != "" {
			out = append(out, s)
		}
		b.Reset()
	}
	for i := 0; i < len(command); i++ {
		c := command[i]
		switch {
		case quote != 0:
			if c == quote {
				quote = 0
			}
			b.WriteByte(c)
		case c == '\'' || c == '"':
			quote = c
			b.WriteByte(c)
		case c == ';' || c == '\n':
			flush()
		case (c == '&' || c == '|') && i+1 < len(command) && command[i+1] == c:
			flush()
			i++
		case c == '|':
			flush()
		default:
			b.WriteByte(c)
		}
		if len(out) > 32 {
			break
		}
	}
	flush()
	return out
}

func words(segment string) []string {
	var out []string
	var b strings.Builder
	quote := byte(0)
	for i := 0; i < len(segment); i++ {
		c := segment[i]
		switch {
		case quote != 0:
			if c == quote {
				quote = 0
			} else {
				b.WriteByte(c)
			}
		case c == '\'' || c == '"':
			quote = c
		case c == ' ' || c == '\t':
			if b.Len() > 0 {
				out = append(out, b.String())
				b.Reset()
			}
		default:
			b.WriteByte(c)
		}
	}
	if b.Len() > 0 {
		out = append(out, b.String())
	}
	return out
}

var runners = map[string]bool{"npm": true, "pnpm": true, "yarn": true, "bun": true, "deno": true}

// normalizeCommand reduces one command segment to "tool script args...",
// dropping leading environment assignments, `npx`-style launchers, the `run`
// verb of package managers and everything after a bare `--`.
func normalizeCommand(segment string) []string {
	w := words(segment)
	for len(w) > 0 && strings.Contains(w[0], "=") && !strings.HasPrefix(w[0], "-") && !strings.HasPrefix(w[0], "=") {
		w = w[1:]
	}
	for len(w) > 0 {
		switch strings.ToLower(w[0]) {
		case "sudo", "time", "env", "npx", "pnpx", "bunx", "exec":
			w = w[1:]
			continue
		}
		break
	}
	if len(w) == 0 {
		return nil
	}
	tool := strings.ToLower(strings.TrimSuffix(strings.TrimSuffix(lastPart(w[0]), ".exe"), ".cmd"))
	rest := w[1:]
	if runners[tool] {
		// Package managers: `<pm> run x`, `<pm> run-script x`, `<pm> x`.
		var kept []string
		for i := 0; i < len(rest); i++ {
			a := rest[i]
			if a == "--" {
				break
			}
			if strings.HasPrefix(a, "-") && len(kept) == 0 {
				// Options before the script (`--filter api`, `-w`) are kept
				// apart; a filter names a workspace, not the script.
				if (a == "--filter" || a == "-F" || a == "--workspace" || a == "-w" || a == "--prefix" || a == "-C") && i+1 < len(rest) {
					i++
				}
				continue
			}
			if len(kept) == 0 && (a == "run" || a == "run-script") {
				continue
			}
			kept = append(kept, a)
		}
		tool = "pm"
		rest = kept
	} else {
		var kept []string
		for _, a := range rest {
			if a == "--" {
				break
			}
			kept = append(kept, a)
		}
		rest = kept
	}
	return append([]string{tool}, rest...)
}

func lastPart(p string) string {
	p = strings.ReplaceAll(p, "\\", "/")
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[i+1:]
	}
	return p
}

// commandMatches reports whether the agent's command runs the recipe's
// command: the same tool and script, with the recipe's arguments as a prefix.
func commandMatches(agentCommand, recipeCommand string) bool {
	want := normalizeCommand(recipeCommand)
	if len(want) == 0 {
		return false
	}
	for _, seg := range shellSegments(agentCommand) {
		got := normalizeCommand(seg)
		if len(got) < len(want) {
			continue
		}
		// A bare tool (`make`, `pm`) with no script never matches: it would
		// fire on every command that tool runs.
		if len(want) == 1 && !(want[0] != "pm" && len(got) == 1) {
			continue
		}
		ok := true
		for i := range want {
			if !strings.EqualFold(got[i], want[i]) {
				ok = false
				break
			}
		}
		if ok {
			return true
		}
	}
	return false
}

// cdTarget returns the literal folder of a leading `cd <dir> &&`, so the repo
// of `cd ../api && npm test` is the api folder, not the shell's folder.
func cdTarget(command string) string {
	segs := shellSegments(command)
	if len(segs) < 2 {
		return ""
	}
	w := words(segs[0])
	if len(w) == 2 && (w[0] == "cd" || w[0] == "pushd") && !strings.ContainsAny(w[1], "$`*?~") {
		return w[1]
	}
	return ""
}

// failureLines returns the normalized lines of a failed command's output
// that can carry a signature: error lines, without the exit-code header.
func failureLines(text string) []string {
	if len(text) > 64*1024 {
		text = text[:32*1024] + "\n" + text[len(text)-32*1024:]
	}
	var out []string
	for _, l := range strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n") {
		l = strings.TrimSpace(l)
		if l == "" || strings.HasPrefix(l, "Exit code") {
			continue
		}
		out = append(out, l)
		if len(out) >= 400 {
			break
		}
	}
	return out
}

// signatureMatches is exact by design: the recorded signature must appear
// whole in one output line, after collapsing whitespace. Near misses stay
// silent.
func signatureMatches(lines []string, signature string) bool {
	sig := collapse(signature)
	if len(sig) < 8 {
		return false
	}
	for _, l := range lines {
		if strings.Contains(collapse(l), sig) {
			return true
		}
	}
	return false
}

func collapse(s string) string { return strings.Join(strings.Fields(s), " ") }

// codexFailed reads Codex's "Exit code: N" output header, the only failure
// signal Codex gives, when the profile has not already marked the failure.
func codexFailed(t toolView) bool {
	if t.output == nil {
		return false
	}
	if !t.output.OK {
		return true
	}
	if t.output.ExitCode != nil {
		return *t.output.ExitCode != 0
	}
	first, _, _ := strings.Cut(t.output.Text, "\n")
	rest, ok := strings.CutPrefix(strings.TrimSpace(first), "Exit code:")
	return ok && strings.TrimSpace(rest) != "0"
}
