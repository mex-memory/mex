package delivery

import (
	"iter"
	"path/filepath"
	"runtime"
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
		if readsOrSearches(command) && !redirectsToFile(command) {
			return true
		}
		write = true
		dir, changeDir := cwd, false
		for word := range shellPathWords(command) {
			// `cd <dir> && ...` moves later relative paths. The folder it
			// enters is where the command runs, not something it writes.
			if changeDir {
				changeDir = false
				if next, ok := shellDirectory(dir, word); ok {
					dir = next
				}
				continue
			}
			if changesDirectory(word) {
				changeDir = true
				continue
			}
			target, ok := shellTarget(ev.Checkout, dir, word)
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
			if !quoted && (lastPart(word) == "sed" || lastPart(word) == "perl") {
				editor = true // also after `cd x &&` or inside a loop
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

// redirectsToFile reports an unquoted `>` or `>>` into a file: `sed ... > x.ts`
// and `cat tmp > x.ts` write although sed and cat only read. Redirects to
// /dev/null, $null, NUL or another stream (&1) write nothing.
func redirectsToFile(command string) bool {
	quote := byte(0)
	for i := 0; i < len(command); i++ {
		c := command[i]
		switch {
		case quote != 0:
			if c == quote {
				quote = 0
			}
		case c == '\'' || c == '"':
			quote = c
		case c == '>':
			j := i + 1
			if j < len(command) && command[j] == '>' {
				j++
			}
			for j < len(command) && (command[j] == ' ' || command[j] == '\t') {
				j++
			}
			end := j
			for end < len(command) && !strings.ContainsRune(" \t\r\n;|&)", rune(command[end])) {
				end++
			}
			target := strings.Trim(command[j:end], "'\"")
			if j < len(command) && command[j] == '&' {
				target = ""
			}
			switch strings.ToLower(target) {
			case "", "/dev/null", "$null", "nul":
			default:
				return true
			}
			i = end - 1
		}
	}
	return false
}

func changesDirectory(word string) bool {
	switch strings.ToLower(word) {
	case "cd", "pushd", "set-location", "sl", "chdir":
		return true
	}
	return false
}

// shellDirectory resolves the folder a cd enters, or reports that only the
// shell's own state (a variable, ~, cd -) could say.
func shellDirectory(cwd, word string) (string, bool) {
	word = gitBashPath(word)
	if word == "" || strings.HasPrefix(word, "-") || strings.ContainsAny(word, "\x00\r\n$\x60~*?") {
		return "", false
	}
	name := filepath.FromSlash(strings.ReplaceAll(word, "\\", "/"))
	if filepath.IsAbs(name) {
		return filepath.Clean(name), true
	}
	if filepath.VolumeName(name) != "" || strings.HasPrefix(word, "/") {
		return "", false
	}
	return filepath.Join(cwd, name), true
}

// gitBashPath reads Git Bash's /c/... form as C:/... on Windows, where
// agents running bash name files that way.
func gitBashPath(word string) string {
	if runtime.GOOS == "windows" && len(word) >= 3 && word[0] == '/' && word[2] == '/' &&
		(word[1] >= 'a' && word[1] <= 'z' || word[1] >= 'A' && word[1] <= 'Z') {
		return strings.ToUpper(word[1:2]) + ":" + word[2:]
	}
	return word
}

func shellTarget(checkout, cwd, word string) (string, bool) {
	word = gitBashPath(word)
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
