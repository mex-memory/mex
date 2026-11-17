// Package shellparse reads evidence out of shell commands and apply_patch
// payloads. It only parses text; nothing here ever runs a command.
//
// Paths come back absolute, resolved against the command's working folder.
// Deciding which project a path belongs to happens later.
package shellparse

import (
	"path"
	"regexp"
	"strconv"
	"strings"
	"sync"
)

const maxCommand = 64 * 1024

const maxReads = 20

// Segments splits a command on |, ;, & and newlines outside quotes.
func Segments(command string) []string {
	if len(command) > maxCommand {
		command = command[:maxCommand]
	}
	var out []string
	var quote byte
	start := 0
	escaped := false
	for i := 0; i < len(command); i++ {
		c := command[i]
		if escaped {
			escaped = false
			continue
		}
		if c == '\\' && quote != '\'' {
			escaped = true
			continue
		}
		if quote != 0 {
			if c == quote {
				quote = 0
			}
			continue
		}
		if c == '\'' || c == '"' {
			quote = c
			continue
		}
		if c == '|' || c == ';' || c == '&' || c == '\n' {
			if s := strings.TrimSpace(command[start:i]); s != "" {
				out = append(out, s)
			}
			start = i + 1
		}
	}
	if s := strings.TrimSpace(command[start:]); s != "" {
		out = append(out, s)
	}
	return out
}

var wordRe = lazyRegexp(`"[^"\n]*"|'[^'\n]*'|[^\s]+`)

// Words splits one segment into words, dropping the outer quotes.
func Words(segment string) []string {
	raw := wordRe().FindAllString(segment, -1)
	out := make([]string, len(raw))
	for i, w := range raw {
		out[i] = unquote(w)
	}
	return out
}

func unquote(w string) string {
	if len(w) > 0 && (w[0] == '"' || w[0] == '\'') {
		w = w[1:]
	}
	if len(w) > 0 && (w[len(w)-1] == '"' || w[len(w)-1] == '\'') {
		w = w[:len(w)-1]
	}
	return w
}

var msysDrive = lazyRegexp(`^/([a-zA-Z])/`)

// Resolve makes a path from a command absolute against cwd, with forward
// slashes on every OS so the same payload gives the same path anywhere.
// A Git Bash path such as /c/src becomes C:/src. Go's file APIs accept
// forward slashes on Windows.
func Resolve(cwd, p string) string {
	p = msysDrive().ReplaceAllString(slashes(p), "$1:/")
	if !isAbs(p) {
		if p == "" {
			p = slashes(cwd)
		} else {
			p = slashes(cwd) + "/" + p
		}
	}
	return path.Clean(p)
}

func slashes(p string) string { return strings.ReplaceAll(p, `\`, "/") }

// isAbs accepts both POSIX and Windows absolute paths on any OS, since
// payloads can come from another machine or a recorded fixture.
func isAbs(p string) bool {
	if strings.HasPrefix(p, "/") || strings.HasPrefix(p, `\`) {
		return true
	}
	return len(p) >= 3 && p[1] == ':' && (p[2] == '/' || p[2] == '\\')
}

var searchStart = lazyRegexp(`^(?:(?:rg|grep|egrep|fgrep|ag|ack)\s|git\s+grep\s)`)
var psSearchStart = lazyRegexp(`(?i)^(?:Select-String|sls)\s`)

// SearchSegment returns the first segment that runs a text search, or "".
func SearchSegment(command string) string {
	for _, s := range Segments(command) {
		if searchStart().MatchString(s) || psSearchStart().MatchString(s) {
			return s
		}
	}
	return ""
}

// SearchCwd is the folder the first search runs in, following plain `cd dir` segments.
func SearchCwd(command, cwd string) string {
	for _, s := range Segments(command) {
		if SearchSegment(s) != "" {
			break
		}
		w := Words(s)
		if len(w) == 2 && w[0] == "cd" {
			cwd = Resolve(cwd, w[1])
		}
	}
	return cwd
}

var takesValue = lazyRegexp(`^(--glob|--iglob|--type|--type-not|--max-count|--max-columns|-g|-t|-T|-A|-B|-C|-m|-f|--file)$`)
var psTakesValue = lazyRegexp(`(?i)^-(?:LiteralPath|Path|Encoding|Context)$`)

// SearchPattern is the pattern of the first search, including when a later
// segment filters its output.
func SearchPattern(command string) string {
	seg := SearchSegment(command)
	if seg == "" {
		return ""
	}
	t := Words(seg)
	if len(t) > 0 && psSearchProgram().MatchString(t[0]) {
		for i, w := range t {
			if strings.EqualFold(w, "-Pattern") {
				if i+1 < len(t) {
					return t[i+1]
				}
				return ""
			}
		}
		t = t[1:]
		for len(t) > 0 {
			w := t[0]
			t = t[1:]
			if psTakesValue().MatchString(w) {
				if len(t) > 0 {
					t = t[1:]
				}
				continue
			}
			if !strings.HasPrefix(w, "-") {
				return w
			}
		}
		return ""
	}
	if len(t) > 0 && t[0] == "git" {
		t = t[1:]
	}
	if len(t) > 0 {
		t = t[1:]
	}
	for len(t) > 0 {
		w := t[0]
		t = t[1:]
		switch {
		case w == "--" || w == "-e" || w == "--regexp":
			if len(t) > 0 {
				return t[0]
			}
			return ""
		case strings.HasPrefix(w, "--regexp="):
			return w[len("--regexp="):]
		case takesValue().MatchString(w):
			if len(t) > 0 {
				t = t[1:]
			}
		case strings.HasPrefix(w, "-"):
		default:
			return w
		}
	}
	return ""
}

// Read is one explicit file read in a command. Offset is 1-based. Tail is set
// instead of Offset/Limit when only the last lines were read.
type Read struct {
	Path   string
	Offset int
	Limit  int
	Tail   int
}

var numberedSlice = lazyRegexp(`^(?:nl\s+-ba|cat)\s+("[^"\n]+"|'[^'\n]+'|[^\s|;]+)\s*\|\s*sed\s+-n\s+['"]?(\d+)(?:,(\d+))?p['"]?\s*$`)
var sedRange = lazyRegexp(`^(\d+)(?:,(\d+))?p$`)
var unsafeSegment = lazyRegexp("[<>`]|\\$\\(")

// Reads lists explicit file reads (sed -n, head, tail, cat, nl and the
// PowerShell forms). Pipelines that read stdin never invent a range.
// precisePipes accepts the exact `nl -ba f | sed -n a,bp` form Codex uses.
func Reads(command, cwd string, precisePipes bool) []Read {
	if precisePipes {
		if m := numberedSlice().FindStringSubmatch(strings.TrimSpace(command)); m != nil {
			off, err1 := strconv.Atoi(m[2])
			end := off
			var err2 error
			if m[3] != "" {
				end, err2 = strconv.Atoi(m[3])
			}
			if err1 != nil || err2 != nil || off < 1 || end < off {
				return nil
			}
			return []Read{{Path: Resolve(cwd, unquote(m[1])), Offset: off, Limit: end - off + 1}}
		}
	}
	if ps, ok := powershellReads(command, cwd); ok {
		return ps
	}
	var reads []Read
	for _, seg := range Segments(command) {
		w := Words(seg)
		if len(w) == 0 {
			continue
		}
		program := w[0]
		w = w[1:]
		if program == "cd" && len(w) == 1 {
			cwd = Resolve(cwd, w[0])
			continue
		}
		if program != "sed" && program != "head" && program != "tail" && program != "cat" && program != "nl" {
			continue
		}
		if unsafeSegment().MatchString(seg) {
			continue
		}
		var offset, limit, tail int
		switch program {
		case "sed":
			if len(w) < 2 || w[0] != "-n" {
				continue
			}
			m := sedRange().FindStringSubmatch(w[1])
			w = w[2:]
			if m == nil {
				continue
			}
			offset, _ = strconv.Atoi(m[1])
			last := offset
			if m[2] != "" {
				last, _ = strconv.Atoi(m[2])
			}
			limit = last - offset + 1
			if offset < 1 || limit < 1 {
				continue
			}
		case "head", "tail":
			count := 10
			switch {
			case len(w) > 0 && w[0] == "-n":
				if len(w) < 2 {
					continue
				}
				n, err := strconv.Atoi(w[1])
				if err != nil {
					continue
				}
				count, w = n, w[2:]
			case len(w) > 0 && dashNumber().MatchString(w[0]):
				count, _ = strconv.Atoi(w[0][1:])
				w = w[1:]
			case len(w) > 0 && strings.HasPrefix(w[0], "--lines="):
				n, err := strconv.Atoi(w[0][len("--lines="):])
				if err != nil {
					continue
				}
				count, w = n, w[1:]
			case len(w) > 0 && strings.HasPrefix(w[0], "-") && w[0] != "--":
				continue
			}
			if count <= 0 {
				continue
			}
			if program == "head" {
				offset, limit = 1, count
			} else {
				// A tail's offset needs the file length; no range is guessed.
				tail = count
			}
		}
		for i := 0; i < len(w) && len(reads) < maxReads; i++ {
			word := w[i]
			if program == "nl" && (word == "-b" || word == "-s" || word == "-w" || word == "-v" || word == "-i") {
				i++
				continue
			}
			if strings.HasPrefix(word, "-") {
				continue
			}
			reads = append(reads, Read{Path: Resolve(cwd, word), Offset: offset, Limit: limit, Tail: tail})
		}
	}
	return reads
}

var psReadHint = lazyRegexp(`(?i)(?:^|[;(\s])(?:Get-Content|gc|type)\s|(?:^|[;(\s])cat\s.*(?:-(?:Path|TotalCount|Head|First|Tail)\b|\|\s*Select-Object)|\bSelect-Object\s+-(?:First|Last)`)
var psUnsafe = lazyRegexp("[<>`$*?{}]")
var psIndexed = lazyRegexp(`^\((.+)\)\[(\d+)\.\.(\d+)\]$`)
var psCd = lazyRegexp(`(?i)^(?:cd|Set-Location)$`)
var psReader = lazyRegexp(`(?i)^(?:Get-Content|gc|cat|type)$`)
var psPath = lazyRegexp(`(?i)^-(?:Path|LiteralPath)$`)
var psCount = lazyRegexp(`(?i)^-(?:TotalCount|Head|First|Tail)$`)
var psSelect = lazyRegexp(`(?i)^Select-Object\s+-(First|Last)\s+(\d+)$`)
var psSelectAny = lazyRegexp(`(?i)^Select-Object\b`)

// powershellReads handles literal PowerShell reads only: no expansion,
// script blocks or globs. ok is false when the command isn't PowerShell-like.
func powershellReads(command, cwd string) ([]Read, bool) {
	if !psReadHint().MatchString(command) {
		return nil, false
	}
	out := []Read{}
	segs := Segments(command)
	for s := 0; s < len(segs) && len(out) < maxReads; s++ {
		seg := segs[s]
		if psUnsafe().MatchString(seg) {
			continue
		}
		var offset, limit, tail int
		if m := psIndexed().FindStringSubmatch(seg); m != nil {
			a, _ := strconv.Atoi(m[2])
			b, _ := strconv.Atoi(m[3])
			if b < a {
				continue
			}
			seg, offset, limit = m[1], a+1, b-a+1
		}
		w := Words(seg)
		if len(w) == 0 {
			continue
		}
		program := w[0]
		w = w[1:]
		if psCd().MatchString(program) && len(w) == 1 {
			cwd = Resolve(cwd, w[0])
			continue
		}
		if !psReader().MatchString(program) {
			continue
		}
		var files []string
		valid := true
		for i := 0; i < len(w); i++ {
			word := w[i]
			switch {
			case psPath().MatchString(word):
				if i+1 >= len(w) || strings.HasPrefix(w[i+1], "-") {
					valid = false
				} else {
					i++
					files = append(files, w[i])
				}
			case psCount().MatchString(word):
				i++
				n := -1
				if i < len(w) {
					if v, err := strconv.Atoi(w[i]); err == nil {
						n = v
					}
				}
				if n <= 0 || offset != 0 || tail != 0 {
					valid = false
				} else if strings.EqualFold(word, "-Tail") {
					tail = n
				} else {
					offset, limit = 1, n
				}
			case strings.HasPrefix(word, "-"):
				valid = false
			default:
				files = append(files, word)
			}
			if !valid {
				break
			}
		}
		if s+1 < len(segs) {
			if m := psSelect().FindStringSubmatch(segs[s+1]); m != nil {
				s++
				n, _ := strconv.Atoi(m[2])
				last := strings.EqualFold(m[1], "last")
				switch {
				case n <= 0 || tail != 0:
					valid = false
				case offset != 0 && limit != 0:
					if last && limit > n {
						offset += limit - n
					}
					if n < limit {
						limit = n
					}
				case !last:
					offset, limit = 1, n
				default:
					tail = n
				}
			} else if psSelectAny().MatchString(segs[s+1]) {
				valid = false
			}
		}
		if !valid {
			continue
		}
		for _, f := range files {
			if len(out) >= maxReads {
				break
			}
			out = append(out, Read{Path: Resolve(cwd, f), Offset: offset, Limit: limit, Tail: tail})
		}
	}
	return out, true
}

var codexHeader = lazyRegexp(`^Exit code: (-?\d+)\r?\nWall time: [^\r\n]*\r?\nOutput:\r?\n`)

// Output strips the execution header Codex puts on shell results and returns
// the exit code it reports, if any.
func Output(response string) (body string, exitCode *int) {
	m := codexHeader().FindStringSubmatch(response)
	if m == nil {
		return response, nil
	}
	n, err := strconv.Atoi(m[1])
	if err != nil {
		return response[len(m[0]):], nil
	}
	return response[len(m[0]):], &n
}

var dashNumber = lazyRegexp(`^-\d+$`)
var psSearchProgram = lazyRegexp(`(?i)^(?:Select-String|sls)$`)

// lazyRegexp compiles on first use, so hook calls that never parse a command
// don't pay for compiling every pattern at start-up.
func lazyRegexp(expr string) func() *regexp.Regexp {
	return sync.OnceValue(func() *regexp.Regexp { return regexp.MustCompile(expr) })
}
