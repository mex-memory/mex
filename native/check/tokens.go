package check

import (
	"path"
	"strings"
)

// A small tolerant tokenizer for the languages the file index parses. It
// is enough to compare code ignoring layout and comments, and to read a
// literal value; it is not a parser.

type tokenKind int

const (
	tIdent tokenKind = iota
	tNumber
	tString
	tPunct
)

type token struct {
	kind tokenKind
	text string // for strings: the unquoted body as written
	line int    // 1-based
}

type language int

const (
	langOther language = iota
	langJS             // TypeScript, JavaScript
	langPython
	langCLike // Rust, C#, Go: // and /* */ comments
)

func languageOf(name string) language {
	switch strings.ToLower(path.Ext(name)) {
	case ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs":
		return langJS
	case ".py", ".pyi":
		return langPython
	case ".rs", ".cs", ".go", ".java", ".kt", ".swift", ".c", ".h", ".cpp", ".hpp":
		return langCLike
	}
	return langOther
}

func isIdentStart(c byte) bool {
	return c == '_' || c == '$' || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c >= 0x80
}

func isIdentPart(c byte) bool { return isIdentStart(c) || (c >= '0' && c <= '9') }

// tokenize splits source into tokens, dropping whitespace and comments.
func tokenize(src []byte, lang language) []token {
	var out []token
	line := 1
	n := len(src)
	for i := 0; i < n; {
		c := src[i]
		switch {
		case c == '\n':
			line++
			i++
		case c == ' ' || c == '\t' || c == '\r' || c == '\f' || c == '\v':
			i++
		case lang != langPython && c == '/' && i+1 < n && src[i+1] == '/':
			for i < n && src[i] != '\n' {
				i++
			}
		case lang != langPython && c == '/' && i+1 < n && src[i+1] == '*':
			i += 2
			for i < n && !(src[i] == '*' && i+1 < n && src[i+1] == '/') {
				if src[i] == '\n' {
					line++
				}
				i++
			}
			i += 2
		case lang == langPython && c == '#':
			for i < n && src[i] != '\n' {
				i++
			}
		case c == '"' || c == '\'' || c == '`':
			start := line
			quote := string(c)
			if lang == langPython && i+2 < n && src[i+1] == c && src[i+2] == c {
				quote = strings.Repeat(string(c), 3)
			}
			if lang == langCLike && c == '\'' && !charLiteral(src, i) {
				// A Rust lifetime or label: keep it as punctuation and an ident.
				out = append(out, token{tPunct, "'", line})
				i++
				continue
			}
			j := i + len(quote)
			var body strings.Builder
			for j < n && !strings.HasPrefix(string(src[j:min(n, j+len(quote))]), quote) {
				if src[j] == '\\' && j+1 < n {
					body.WriteByte(src[j])
					body.WriteByte(src[j+1])
					j += 2
					continue
				}
				if src[j] == '\n' {
					line++
					if len(quote) == 1 && c != '`' {
						break
					}
				}
				body.WriteByte(src[j])
				j++
			}
			out = append(out, token{tString, body.String(), start})
			i = min(n, j+len(quote))
		case c >= '0' && c <= '9' || (c == '.' && i+1 < n && src[i+1] >= '0' && src[i+1] <= '9'):
			j := i
			for j < n && (isIdentPart(src[j]) || src[j] == '.' || ((src[j] == '+' || src[j] == '-') && (src[j-1] == 'e' || src[j-1] == 'E'))) {
				j++
			}
			out = append(out, token{tNumber, string(src[i:j]), line})
			i = j
		case isIdentStart(c):
			j := i
			for j < n && isIdentPart(src[j]) {
				j++
			}
			out = append(out, token{tIdent, string(src[i:j]), line})
			i = j
		default:
			out = append(out, token{tPunct, string(c), line})
			i++
		}
	}
	return out
}

// charLiteral reports whether a quote at i starts a character literal like
// 'a' or '\n' rather than a Rust lifetime.
func charLiteral(src []byte, i int) bool {
	if i+2 < len(src) && src[i+1] == '\\' {
		return true
	}
	return i+2 < len(src) && src[i+2] == '\''
}

// unquote turns a string token's body into its value for the common escapes.
func unquote(body string) string {
	if !strings.Contains(body, "\\") {
		return body
	}
	var b strings.Builder
	for i := 0; i < len(body); i++ {
		if body[i] != '\\' || i+1 == len(body) {
			b.WriteByte(body[i])
			continue
		}
		i++
		switch body[i] {
		case 'n':
			b.WriteByte('\n')
		case 't':
			b.WriteByte('\t')
		case 'r':
			b.WriteByte('\r')
		default:
			b.WriteByte(body[i])
		}
	}
	return b.String()
}
