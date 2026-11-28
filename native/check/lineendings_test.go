package check

import (
	"strings"
	"testing"
)

func crlf(s string) string { return strings.ReplaceAll(s, "\n", "\r\n") }

// Git may check a commit out with other line endings than the ones an entry
// was recorded with: learned entries are recorded from the commit itself.
func TestLineEndingsAreNotAChange(t *testing.T) {
	const code = "export const defaults = {\n  allowMethods: ['GET'],\n}\n"
	for _, c := range []struct{ name, recorded, now string }{
		{"recorded from the commit", code, crlf(code)},
		{"recorded in a Windows checkout", crlf(code), code},
		{"mixed", strings.Replace(crlf(code), "\r\n", "\n", 1), code},
	} {
		t.Run(c.name, func(t *testing.T) {
			root := t.TempDir()
			floor := Check{Kind: "relation", Role: Complete, Target: map[string]any{}, Saw: map[string]any{},
				Files: map[string]string{"src/cors.ts": hashBytes([]byte(c.recorded))}}
			write(t, root, "src/cors.ts", c.now)
			want := Held
			if c.name == "mixed" {
				want = Changed // a file git never wrote that way
			}
			if r := verdict(t, root, floor); r.Verdict != want {
				t.Fatalf("other line endings: %+v", r)
			}
			write(t, root, "src/cors.ts", strings.Replace(c.now, "GET", "PUT", 1))
			if r := verdict(t, root, floor); r.Verdict != Changed {
				t.Fatalf("other content: %+v", r)
			}
		})
	}
}

func TestFingerprintsIgnoreLineEndings(t *testing.T) {
	for _, c := range []struct {
		lang language
		code string
	}{
		{langJS, "export function send(a) {\n  const t = `one\n  two`;\n  /* three\n  four */ return t;\n}\n"},
		{languageOf("a.py"), "def send(a):\n    \"\"\"one\n    two\"\"\"\n    return a\n"},
		{languageOf("a.go"), "func send() string {\n\treturn `one\ntwo`\n}\n"},
	} {
		lf := fingerprintSpan([]byte(c.code), c.lang, 1, 9, "function", "send")
		if cr := fingerprintSpan([]byte(crlf(c.code)), c.lang, 1, 9, "function", "send"); cr != lf {
			t.Errorf("%v: %s and %s", c.lang, lf, cr)
		}
		// An entry recorded on Windows before this keeps its verdict there.
		older := fingerprintText([]byte(crlf(c.code)), c.lang, 1, 9, "function", "send")
		if older == lf || !matchesFingerprint([]byte(crlf(c.code)), c.lang, 1, 9, "function", "send", older) {
			t.Errorf("%v: the older fingerprint no longer matches", c.lang)
		}
		if matchesFingerprint([]byte(crlf(strings.Replace(c.code, "two", "2", 1))), c.lang, 1, 9, "function", "send", older) {
			t.Errorf("%v: changed code matches", c.lang)
		}
	}
}

func TestQuotesIgnoreLineEndings(t *testing.T) {
	const doc = "# Rules\n\nUse the adapter.\nNever call\nthe fallback.\n"
	root := t.TempDir()
	write(t, root, "CONTRIBUTING.md", doc)
	c := record(t, root, "quote", Complete, map[string]any{"file": "CONTRIBUTING.md", "exact": "Never call\nthe fallback."})
	write(t, root, "CONTRIBUTING.md", crlf(doc))
	if r := verdict(t, root, c); r.Verdict != Held {
		t.Fatalf("%+v", r)
	}
}
