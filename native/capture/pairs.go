package capture

import (
	"strconv"
	"strings"
)

// Failed-then-passed doesn't prove the cause (plan sheet 22). A pair becomes a
// hint only under the strict rule, and it is never called verified:
//
//   - a real command: no inline scripts, loops, subshells or here-documents;
//   - nothing else ran or changed in between;
//   - only flags differ, or a prerequisite was added;
//   - not a narrower run, an output filter, a check turned off, or --help;
//   - and the same failure returns in a later session where MEX didn't
//     deliver the fix (see the pair store).
//
// A rerun that passes with nothing changed is a flaky signal, not a fix.

// Verdict is what the strict rule makes of one failed-then-passed pair.
type Verdict string

const (
	// Candidate passes the rule within the session. It becomes a hint only
	// when the same failure returns in a later session.
	Candidate Verdict = "candidate"
	// Flaky is a rerun that passed with nothing changed.
	Flaky Verdict = "flaky"
	// Rejected pairs teach nothing and are not kept.
	Rejected Verdict = "rejected"
)

// Classify applies the strict rule to a failed command, the command that
// passed next, and whether anything else ran or changed in between.
func Classify(failed, passed string, failedExit int, otherBetween bool) (Verdict, string) {
	if otherBetween {
		return Rejected, "something else ran or changed in between"
	}
	if failedExit == 0 {
		return Rejected, "the first command didn't fail"
	}
	if failedExit >= 128 {
		return Rejected, "the first command was interrupted or killed"
	}
	f, reason := parseCommand(failed)
	if reason != "" {
		return Rejected, reason
	}
	if len(f) != 1 {
		return Rejected, "the failed command isn't one command"
	}
	p, reason := parseCommand(passed)
	if reason != "" {
		return Rejected, reason
	}
	run := p[len(p)-1]
	prereqs := p[:len(p)-1]
	for _, s := range p {
		if s.op != "" && s.op != "&&" {
			return Rejected, "commands joined by " + s.op + " hide a failure"
		}
	}
	for _, s := range prereqs {
		if why := prerequisiteProblem(s); why != "" {
			return Rejected, why
		}
	}
	if why := runProblem(run); why != "" {
		return Rejected, why
	}
	fs := f[0]
	if run.program() != fs.program() {
		return Rejected, "a different command"
	}
	fp, rp := fs.positionals(), run.positionals()
	if len(rp) > len(fp) && equalStrings(rp[:len(fp)], fp) {
		return Rejected, "a narrower run"
	}
	if !equalStrings(fp, rp) {
		return Rejected, "a different command"
	}
	added, removed := flagDiff(fs, run)
	for _, flag := range added {
		if narrowingFlag(flag) {
			return Rejected, "a narrower run"
		}
		if disablingFlag(flag) {
			return Rejected, "a check was turned off"
		}
		if !safeAddedFlag(fs, flag) {
			return Rejected, "an unrecognised flag change"
		}
	}
	for _, flag := range removed {
		if strictFlag(flag) {
			return Rejected, "a check was turned off"
		}
		// Removing an option can reduce coverage too. Abstain unless the
		// unchanged run can establish the same work, rather than guessing.
		return Rejected, "a flag was removed"
	}
	flagsChanged := len(added) > 0 || len(removed) > 0
	switch {
	case len(prereqs) > 0 && flagsChanged:
		return Rejected, "more than one thing changed"
	case len(prereqs) > 0:
		return Candidate, "a prerequisite was added"
	case flagsChanged:
		return Candidate, "only flags differ"
	}
	return Flaky, "passed on a rerun with nothing changed"
}

// safeAddedFlag recognises execution/cache settings and additions that keep
// or expand the work. Unknown flags abstain: a blacklist cannot know every
// runner's selection, listing, collection-only or plugin-defined options.
// Match the command as well as the complete option/value, so a familiar flag
// on a different program is never assumed to have the same meaning.
func safeAddedFlag(s segment, flag string) bool {
	command := strings.TrimSpace(s.program() + " " + strings.Join(s.positionals(), " "))
	switch command {
	case "npm test":
		return flag == "--runInBand" || flag == "NODE_ENV=test"
	case "npm install":
		return flag == "--legacy-peer-deps"
	case "npm run lint":
		return flag == "--cache=false"
	case "npm run build":
		return positiveOption(flag, "NODE_OPTIONS=--max-old-space-size=")
	case "go test ./...":
		return flag == "-race" || positiveOption(flag, "-count=") || positiveOption(flag, "-p=") || positiveOption(flag, "-parallel=")
	case "cargo build", "cargo test":
		return flag == "--locked" || flag == "--all-features"
	case "docker compose up":
		return flag == "--build"
	case "gradle build", "./gradlew build":
		return flag == "--refresh-dependencies"
	case "mvn package":
		return flag == "-U"
	case "python pytest", "python3 pytest":
		module := false
		for _, f := range s.flags() {
			module = module || f == "-m"
		}
		return module && flag == "--import-mode=importlib"
	case "pytest":
		return flag == "--import-mode=importlib"
	case "npx tsc", "tsc":
		return flag == "--incremental=false"
	case "vitest run":
		return flag == "--pool=forks" || flag == "--pool=threads"
	}
	return false
}

func positiveOption(flag, prefix string) bool {
	value, ok := strings.CutPrefix(flag, prefix)
	if !ok || value == "" || strings.Trim(value, "0123456789") != "" {
		return false
	}
	n, err := strconv.Atoi(value)
	return err == nil && n > 0
}

type segment struct {
	op    string   // the operator before this segment: "", "&&", "||", ";"
	env   []string // leading NAME=value words
	words []string
}

func (s segment) program() string {
	if len(s.words) == 0 {
		return ""
	}
	return s.words[0]
}

// positionals are the words that aren't flags, after the program. A word
// following "--" counts as a flag when it starts with "-".
func (s segment) positionals() []string {
	var out []string
	for _, w := range s.words[min(1, len(s.words)):] {
		if w == "--" || strings.HasPrefix(w, "-") {
			continue
		}
		out = append(out, w)
	}
	return out
}

func (s segment) flags() []string {
	out := append([]string(nil), s.env...)
	for _, w := range s.words[min(1, len(s.words)):] {
		if w != "--" && strings.HasPrefix(w, "-") {
			out = append(out, w)
		}
	}
	return out
}

func flagDiff(a, b segment) (added, removed []string) {
	count := map[string]int{}
	for _, f := range a.flags() {
		count[f]++
	}
	for _, f := range b.flags() {
		if count[f] > 0 {
			count[f]--
			continue
		}
		added = append(added, f)
	}
	for f, n := range count {
		for ; n > 0; n-- {
			removed = append(removed, f)
		}
	}
	return added, removed
}

// parseCommand splits a command on &&, || and ; and rejects anything that
// isn't a plain command line: pipes and redirections (output filters),
// subshells, substitutions, here-documents, loops and background jobs.
func parseCommand(command string) ([]segment, string) {
	command = strings.TrimSpace(command)
	if command == "" {
		return nil, "an empty command"
	}
	if strings.Contains(command, "\n") {
		return nil, "a multi-line script"
	}
	var segs []segment
	var cur strings.Builder
	op := ""
	var quote byte
	flush := func(next string) string {
		words := splitWords(cur.String())
		cur.Reset()
		if len(words) == 0 {
			return "an empty command"
		}
		s := segment{op: op}
		for len(words) > 0 && isAssignment(words[0]) {
			s.env = append(s.env, words[0])
			words = words[1:]
		}
		if len(words) == 0 {
			return "only variable assignments"
		}
		s.words = words
		segs = append(segs, s)
		op = next
		return ""
	}
	for i := 0; i < len(command); i++ {
		c := command[i]
		if quote != 0 {
			if c == '\\' && quote == '"' && i+1 < len(command) {
				cur.WriteByte(c)
				i++
				cur.WriteByte(command[i])
				continue
			}
			if c == quote {
				quote = 0
			}
			if quote == '"' && (c == '`' || (c == '$' && i+1 < len(command) && command[i+1] == '(')) {
				return nil, "a command substitution"
			}
			cur.WriteByte(c)
			continue
		}
		switch {
		case c == '\'' || c == '"':
			quote = c
			cur.WriteByte(c)
		case c == '\\' && i+1 < len(command):
			cur.WriteByte(c)
			i++
			cur.WriteByte(command[i])
		case c == '`' || (c == '$' && i+1 < len(command) && command[i+1] == '('):
			return nil, "a command substitution"
		case c == '(' || c == ')' || c == '{' || c == '}':
			return nil, "a subshell or group"
		case c == '<':
			if i+1 < len(command) && command[i+1] == '<' {
				return nil, "a here-document"
			}
			return nil, "an input redirection"
		case c == '>':
			// 2>&1 only merges streams; anything else filters output.
			if strings.HasSuffix(cur.String(), "2") && strings.HasPrefix(command[i:], ">&1") {
				s := cur.String()
				cur.Reset()
				cur.WriteString(s[:len(s)-1])
				i += 2
				continue
			}
			return nil, "an output filter"
		case c == '|':
			if i+1 < len(command) && command[i+1] == '|' {
				if why := flush("||"); why != "" {
					return nil, why
				}
				i++
				continue
			}
			return nil, "an output filter"
		case c == '&':
			if i+1 < len(command) && command[i+1] == '&' {
				if why := flush("&&"); why != "" {
					return nil, why
				}
				i++
				continue
			}
			return nil, "a background job"
		case c == ';':
			if why := flush(";"); why != "" {
				return nil, why
			}
		default:
			cur.WriteByte(c)
		}
	}
	if quote != 0 {
		return nil, "an unclosed quote"
	}
	if why := flush(""); why != "" {
		return nil, why
	}
	for _, s := range segs {
		switch s.program() {
		case "for", "while", "until", "do", "done", "if", "then", "fi", "case", "select", "function":
			return nil, "a loop or a script"
		}
	}
	return segs, ""
}

func splitWords(s string) []string {
	var out []string
	var cur strings.Builder
	var quote byte
	has := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case quote != 0:
			if c == quote {
				quote = 0
			} else if c == '\\' && quote == '"' && i+1 < len(s) {
				i++
				cur.WriteByte(s[i])
			} else {
				cur.WriteByte(c)
			}
		case c == '\'' || c == '"':
			quote, has = c, true
		case c == '\\' && i+1 < len(s):
			i++
			cur.WriteByte(s[i])
			has = true
		case c == ' ' || c == '\t':
			if has {
				out = append(out, cur.String())
				cur.Reset()
				has = false
			}
		default:
			cur.WriteByte(c)
			has = true
		}
	}
	if has {
		out = append(out, cur.String())
	}
	return out
}

func isAssignment(w string) bool {
	eq := strings.IndexByte(w, '=')
	if eq <= 0 {
		return false
	}
	for i, c := range w[:eq] {
		if !(c == '_' || c >= 'A' && c <= 'Z' || c >= 'a' && c <= 'z' || i > 0 && c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}

var interpreters = map[string]bool{
	"sh": true, "bash": true, "zsh": true, "dash": true, "fish": true, "pwsh": true, "powershell": true, "cmd": true,
	"python": true, "python3": true, "node": true, "deno": true, "bun": true, "ruby": true, "perl": true, "php": true,
}

var inlineFlags = map[string]bool{"-c": true, "-e": true, "--eval": true, "-p": true, "--print": true, "-Command": true, "-command": true, "/c": true, "-r": true}

func inlineScript(s segment) bool {
	p := s.program()
	if p == "eval" || p == "source" || p == "." || p == "xargs" || p == "exec" || p == "watch" || p == "timeout" {
		return true
	}
	if !interpreters[strings.TrimSuffix(strings.ToLower(p[strings.LastIndexAny(p, `/\`)+1:]), ".exe")] {
		return false
	}
	for _, w := range s.words[1:] {
		if inlineFlags[w] || w == "-" {
			return true
		}
	}
	return false
}

func runProblem(s segment) string {
	if inlineScript(s) {
		return "an inline script"
	}
	for _, w := range s.words[1:] {
		switch w {
		case "--help", "-h", "-help", "help", "--version", "-V", "version", "-?", "/?":
			return "--help or --version"
		}
	}
	switch s.program() {
	case "echo", "true", "false", ":", "exit", "printf", "test", "[", "sleep", "cd", "export", "set", "unset", "alias":
		return "not a real command"
	}
	return ""
}

func prerequisiteProblem(s segment) string {
	if inlineScript(s) {
		return "an inline script"
	}
	switch s.program() {
	case "cd", "pushd", "popd":
		return "a change of folder makes it a different run"
	case "echo", "true", "false", ":", "printf", "sleep", "set", "unset", "alias":
		return "not a real prerequisite"
	}
	return ""
}

func flagName(f string) string {
	if isAssignment(f) {
		return strings.ToLower(f[:strings.IndexByte(f, '=')])
	}
	name, _, _ := strings.Cut(strings.TrimLeft(f, "-"), "=")
	if len(name) == 1 {
		// Single letters are case-sensitive: jest -u updates snapshots, mvn
		// -U updates dependencies.
		return name
	}
	return strings.ToLower(name)
}

// narrowingFlag selects fewer tests, files or packages than the failed run.
func narrowingFlag(f string) bool {
	switch flagName(f) {
	case "t", "testnamepattern", "test-name-pattern", "testpathpattern", "testpathpatterns", "k", "grep", "g", "fgrep",
		"filter", "run", "only", "spec", "o", "onlychanged", "only-changed", "changed", "since", "lf", "last-failed",
		"failed", "related", "findrelatedtests", "testmatch", "match", "focus", "include", "select", "scope", "package",
		"p", "workspace", "w", "project", "test", "tests", "file", "files", "shard", "bail", "x", "maxfail", "exitfirst", "stop":
		return true
	}
	return false
}

// disablingFlag makes a failing check pass by switching it off.
func disablingFlag(f string) bool {
	name := flagName(f)
	if strings.HasPrefix(name, "skip") || strings.HasPrefix(name, "ignore") || strings.HasPrefix(name, "exclude") ||
		strings.HasPrefix(name, "no-fail") || strings.HasPrefix(name, "disable") || strings.Contains(name, "skip") ||
		strings.HasPrefix(name, "allow") || strings.HasPrefix(name, "no-verify") || strings.HasPrefix(name, "no-check") ||
		strings.HasPrefix(name, "no-lint") || strings.HasPrefix(name, "nolint") {
		return true
	}
	switch name {
	case "force", "f", "passwithnotests", "pass-with-no-tests", "dry-run", "dryrun", "n", "continue-on-error", "keep-going",
		"i", "noverify", "no-strict", "loose", "lenient", "warn-only", "no-error", "no-errors", "quiet-errors", "update-snapshot",
		"u", "updatesnapshot", "update", "accept", "fix", "write", "max-warnings", "no-bail", "silent-errors", "exit-zero", "exit0":
		return true
	}
	return false
}

// strictFlag removed from the failed run loosens a check.
func strictFlag(f string) bool {
	name := flagName(f)
	for _, s := range []string{"strict", "frozen", "ci", "check", "werror", "max-warnings", "fail", "deny", "immutable", "locked", "pedantic", "error"} {
		if strings.Contains(name, s) {
			return true
		}
	}
	return name == "w" || name == "e"
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
