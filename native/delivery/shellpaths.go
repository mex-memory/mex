package delivery

import (
	"iter"
	"path/filepath"
	"strings"

	"github.com/mex-memory/mex/native/index"
	"github.com/mex-memory/mex/native/index/shift"
	"github.com/mex-memory/mex/native/internal/contract"
)

// shellTargets takes literal paths from the write commands of one event.
func shellTargets(ev contract.Event) (targets []string, write, bounded bool) {
	const maxCommandBytes = 64 << 10
	cwd := ev.Cwd
	if cwd == "" {
		cwd = ev.Checkout
	}
	seen := map[string]bool{}
	add := func(tool contract.Tool) bool {
		if tool.Name != contract.ToolShell || tool.Output == nil || tool.Output.Interrupted {
			return true
		}
		command := tool.Input.Command
		if len(command) > maxCommandBytes {
			return false
		}
		if readsOrSearches(command) {
			return true
		}
		write = true
		for word := range shellPathWords(command) {
			target, ok := shellTarget(ev.Checkout, cwd, word)
			if !ok || seen[target] {
				continue
			}
			if len(targets) == index.MaxRecentCodeCandidates {
				return false
			}
			seen[target] = true
			targets = append(targets, target)
		}
		return true
	}
	if ev.Tool != nil && !add(*ev.Tool) {
		return nil, write, false
	}
	for _, tool := range ev.Batch[:min(len(ev.Batch), 64)] {
		if !add(tool) {
			return nil, write, false
		}
	}
	return targets, write, true
}

// shellPathWords keeps quoted literals together and also sees arguments in
// inline function calls and command substitutions. It never expands a word.
func shellPathWords(command string) iter.Seq[string] {
	return func(yield func(string) bool) {
		const split = " \t\r\n;|&(){}[],=<>"
		first, _, _ := strings.Cut(strings.TrimSpace(command), " ")
		editor := lastPart(first) == "sed" || lastPart(first) == "perl"
		skipExpression := false
		for i := 0; i < len(command); {
			if strings.ContainsRune(split, rune(command[i])) {
				i++
				continue
			}
			start := i
			var word string
			quoted := command[i] == '\'' || command[i] == '"'
			if quoted {
				quote := command[i]
				i++
				end := strings.IndexByte(command[i:], quote)
				if end < 0 {
					return
				}
				word = command[i : i+end]
				i += end + 1
			} else {
				for i < len(command) && !strings.ContainsRune(split+"'\"", rune(command[i])) {
					i++
				}
				word = command[start:i]
			}
			if skipExpression {
				skipExpression = false
				continue
			}
			if editor && (word == "-e" || word == "--expression") {
				skipExpression = true
				continue
			}
			if editor && strings.HasPrefix(word, "s/") && strings.Count(word, "/") >= 3 {
				continue // an inline substitution, not a directory
			}
			if quoted && strings.ContainsRune(word, '*') {
				prefix := strings.TrimRight(command[:start], " \t")
				if strings.HasSuffix(prefix, ".glob(") || strings.HasSuffix(prefix, ".rglob(") {
					continue // a filter relative to a Python Path
				}
			}
			if !yield(word) {
				return
			}
		}
	}
}

func shellTarget(checkout, cwd, word string) (string, bool) {
	if word == "" || strings.HasPrefix(word, "-") || strings.HasPrefix(word, "~") ||
		strings.ContainsAny(word, "\x00\r\n$\x60?<>|") {
		return "", false
	}
	word = strings.ReplaceAll(word, "\\", "/")
	if !strings.ContainsRune(word, '/') && shift.LangOf(word) == "other" {
		return "", false
	}
	dir := strings.HasSuffix(word, "/")
	if glob := strings.IndexByte(word, '*'); glob >= 0 {
		word = word[:strings.LastIndexByte(word[:glob], '/')+1]
		dir = true
	}
	name := filepath.FromSlash(word)
	if strings.ContainsRune(name[len(filepath.VolumeName(name)):], ':') {
		return "", false
	}
	if !filepath.IsAbs(name) {
		// Drive-relative and volume-rooted Windows paths need shell state.
		if filepath.VolumeName(name) != "" || strings.HasPrefix(word, "/") {
			return "", false
		}
		name = filepath.Join(cwd, name)
	}
	rel, ok := shellRelative(checkout, name)
	if ok && dir && rel != "." {
		rel += "/"
	}
	return rel, ok
}

func shellRelative(checkout, path string) (string, bool) {
	if !filepath.IsAbs(path) {
		return "", false
	}
	rel, err := filepath.Rel(checkout, path)
	return filepath.ToSlash(rel), err == nil && filepath.IsLocal(rel)
}
