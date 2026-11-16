package output

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// savedCommands is every shell command MEX has a saved copy of: the recorded
// agent payloads, the saved outputs, and commands chosen to break quoting.
func savedCommands(t *testing.T) []string {
	t.Helper()
	seen := map[string]bool{}
	var out []string
	add := func(c string) {
		if c != "" && !seen[c] {
			seen[c] = true
			out = append(out, c)
		}
	}
	var walk func(v any)
	walk = func(v any) {
		switch x := v.(type) {
		case map[string]any:
			for k, val := range x {
				if k == "command" {
					switch c := val.(type) {
					case string:
						add(c)
					case []any:
						for _, part := range c {
							if s, ok := part.(string); ok {
								add(s)
							}
						}
					}
				}
				walk(val)
			}
		case []any:
			for _, val := range x {
				walk(val)
			}
		}
	}
	payloads, _ := filepath.Glob(filepath.Join("..", "internal", "adapter", "*", "testdata", "payloads", "*.json"))
	more, _ := filepath.Glob(filepath.Join("..", "internal", "adapter", "*", "testdata", "payloads", "*", "*.json"))
	payloads = append(payloads, more...)
	if len(payloads) < 20 {
		t.Fatalf("found only %d recorded payloads", len(payloads))
	}
	for _, f := range payloads {
		data, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var v any
		if json.Unmarshal(data, &v) == nil {
			walk(v)
		}
	}
	cmds, _ := filepath.Glob(filepath.Join("testdata", "outputs", "*.cmd"))
	for _, f := range cmds {
		data, _ := os.ReadFile(f)
		add(strings.TrimSpace(string(data)))
	}
	for _, c := range []string{
		`npm test`, `echo 'it'\''s'`, `echo "a 'b' c"`, `grep -rn "don't" src`, `printf '%s\n' "$HOME" '$HOME'`,
		`rg -n 'a\|b' src`, `cd 'dir with spaces' && make`, `echo \\ \' \"`, `python -c "print('x')"`,
		`Get-ChildItem -Path 'C:\Program Files' -Recurse`, `Write-Output ‘typographic’ ’quotes‘`, `echo ''''`,
		`git log --format='%H %s' -n 5`, "echo tab\there", `echo ünïcödé 🎉`, `echo $(whoami) ` + "`date`",
		`npm run test -- --grep "cart > total"`, `C:\tools\bin\go.exe test ./...`, `echo '`, `echo "unterminated`,
		`""`, `''`, `'`, `\`, `& 'x' run --shell bash -- 'y'`,
	} {
		add(c)
	}
	return out
}

// posixWords is an independent reader of POSIX shell words (quotes and
// backslashes only), written for this test: it parses, it never runs.
func posixWords(s string) ([]string, bool) {
	var words []string
	var cur strings.Builder
	in := false
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == ' ' || c == '\t':
			if in {
				words = append(words, cur.String())
				cur.Reset()
				in = false
			}
		case c == '\'':
			end := strings.IndexByte(s[i+1:], '\'')
			if end < 0 {
				return nil, false
			}
			cur.WriteString(s[i+1 : i+1+end])
			i += end + 1
			in = true
		case c == '\\':
			if i+1 >= len(s) {
				return nil, false
			}
			cur.WriteByte(s[i+1])
			i++
			in = true
		case c == '"':
			return nil, false // the wrapper never writes double quotes
		default:
			cur.WriteByte(c)
			in = true
		}
	}
	if in {
		words = append(words, cur.String())
	}
	return words, true
}

// psWords reads PowerShell words the same way: single-quoted strings with
// doubled quotes (straight or typographic), and bare words.
func psWords(s string) ([]string, bool) {
	var words []string
	r := []rune(s)
	for i := 0; i < len(r); {
		switch {
		case r[i] == ' ':
			i++
		case isPSQuote(r[i]):
			var b strings.Builder
			i++
			closed := false
			for i < len(r) {
				if isPSQuote(r[i]) {
					if i+1 < len(r) && isPSQuote(r[i+1]) {
						b.WriteRune(r[i])
						i += 2
						continue
					}
					i++
					closed = true
					break
				}
				b.WriteRune(r[i])
				i++
			}
			if !closed {
				return nil, false
			}
			words = append(words, b.String())
		default:
			j := i
			for j < len(r) && r[j] != ' ' {
				if isPSQuote(r[j]) || r[j] == '"' || r[j] == '$' || r[j] == '`' {
					return nil, false // the wrapper writes none of these bare
				}
				j++
			}
			words = append(words, string(r[i:j]))
			i = j
		}
	}
	return words, true
}

// Quoting round-trips for every saved shell command: the wrapper line parses
// back, in the agent's shell's own rules, to exactly the binary, the wrapper's
// arguments and the original command. Nothing is run.
func TestQuotingRoundTripsForSavedCommands(t *testing.T) {
	binaries := map[string][]string{
		ShellBash:       {"/home/dev/.mex/bin/mex-hook", "/Users/O'Brien/Library/mex dir/mex-hook"},
		ShellZsh:        {"/Users/dev/.mex/bin/mex-hook"},
		ShellPowerShell: {`C:\Users\dev\.mex\bin\mex-hook.exe`, `C:\Users\O'Brien\.mex\bin\mex-hook.exe`, `C:\Program Files\mex\mex-hook.exe`},
	}
	commands := savedCommands(t)
	for shell, bins := range binaries {
		for _, bin := range bins {
			for _, c := range commands {
				line := Wrap(bin, shell, c)
				var words []string
				var ok bool
				if powerShell(shell) {
					if !strings.HasPrefix(line, "& ") {
						t.Fatalf("%s: no call operator: %s", shell, line)
					}
					words, ok = psWords(line[2:])
				} else {
					words, ok = posixWords(line)
				}
				want := []string{bin, "run", "--shell", shell, "--", c}
				if !ok || strings.Join(words, "\x00") != strings.Join(want, "\x00") {
					t.Fatalf("%s %q:\nline  %s\nwords %q", shell, c, line, words)
				}
				original, gotShell, ok := Unwrap(line)
				if !ok || original != c || gotShell != shell {
					t.Fatalf("Unwrap(%s) = %q %q %v", line, original, gotShell, ok)
				}
			}
		}
	}
	t.Logf("%d saved commands round-trip through %d shells", len(commands), len(binaries))
}

func TestUnwrapRejectsOtherCommands(t *testing.T) {
	for _, c := range []string{"npm test", "'x' run --shell fish -- 'y'", "'x' run --shell bash -- 'y' extra", "& 'x' run --shell bash -- 'y'", "'x' run --shell powershell -- 'y'", "'' run --shell bash -- 'y'"} {
		if _, _, ok := Unwrap(c); ok {
			t.Errorf("Unwrap(%q) accepted", c)
		}
	}
}
