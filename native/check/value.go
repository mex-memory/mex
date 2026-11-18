package check

import (
	"errors"
	"strconv"
	"strings"
)

var errNotLiteral = errors.New("not a literal value")

// findValue reads the literal at a dotted path such as
// "defaults.allowMethods": the first segment is a top-level declaration
// (const/let/var/static, or NAME = in Python), the rest are object keys.
// found is false when the name or a key isn't there; err is set when it is
// there but isn't a plain literal.
func findValue(src []byte, lang language, symbol string) (value any, found bool, err error) {
	segments := strings.Split(symbol, ".")
	toks := tokenize(src, lang)
	at := declaration(toks, lang, segments[0])
	if at < 0 {
		return nil, false, nil
	}
	p := &literalParser{toks: toks, pos: at, lang: lang}
	for _, key := range segments[1:] {
		if !p.enterKey(key) {
			return nil, false, nil
		}
	}
	v, err := p.value()
	if err != nil {
		return nil, true, err
	}
	return v, true, nil
}

// declaration finds where the value of a top-level name starts.
func declaration(toks []token, lang language, name string) int {
	depth := 0
	for i := 0; i < len(toks); i++ {
		t := toks[i]
		if t.kind == tPunct {
			switch t.text {
			case "{", "(", "[":
				depth++
			case "}", ")", "]":
				depth--
			}
			continue
		}
		if depth != 0 || t.kind != tIdent || t.text != name {
			continue
		}
		prev := ""
		if i > 0 {
			prev = toks[i-1].text
		}
		switch lang {
		case langPython:
			if (i == 0 || toks[i-1].line < t.line) && i+1 < len(toks) && toks[i+1].text == "=" && !(i+2 < len(toks) && toks[i+2].text == "=") {
				return i + 2
			}
			if i+1 < len(toks) && toks[i+1].text == ":" {
				// NAME: Type = value
				for j := i + 2; j < len(toks) && toks[j].line == t.line; j++ {
					if toks[j].text == "=" {
						return j + 1
					}
				}
			}
		default:
			if prev == "const" || prev == "let" || prev == "var" || prev == "static" || prev == "readonly" {
				// Skip a type annotation up to the "=".
				for j, d := i+1, 0; j < len(toks); j++ {
					switch toks[j].text {
					case "<", "(", "[", "{":
						d++
					case ">", ")", "]", "}":
						d--
					case "=":
						if d == 0 && !(j+1 < len(toks) && (toks[j+1].text == "=" || toks[j+1].text == ">")) {
							return j + 1
						}
					case ";":
						if d == 0 {
							j = len(toks)
						}
					}
				}
			}
		}
	}
	return -1
}

type literalParser struct {
	toks []token
	pos  int
	lang language
}

func (p *literalParser) peek() token {
	if p.pos < len(p.toks) {
		return p.toks[p.pos]
	}
	return token{kind: tPunct, text: ""}
}

func (p *literalParser) next() token {
	t := p.peek()
	p.pos++
	return t
}

// skipWrappers steps over "(" and leading casts like Object.freeze( that
// wrap a literal.
func (p *literalParser) skipWrappers() int {
	opened := 0
	for {
		t := p.peek()
		if t.kind != tIdent || !wrapperNames[t.text] {
			return opened
		}
		save := p.pos
		p.pos++
		switch p.peek().text {
		case ".":
			p.pos++
		case "(":
			p.pos++
			opened++
		default:
			p.pos = save
			return opened
		}
	}
}

// enterKey moves into the object literal at the cursor and onto key's value.
func (p *literalParser) enterKey(key string) bool {
	p.skipWrappers()
	if p.next().text != "{" {
		return false
	}
	depth := 0
	for p.pos < len(p.toks) {
		t := p.next()
		switch t.text {
		case "{", "[", "(":
			depth++
			continue
		case "}", "]", ")":
			if depth == 0 {
				return false
			}
			depth--
			continue
		}
		if depth != 0 {
			continue
		}
		if (t.kind == tIdent || t.kind == tString || t.kind == tNumber) && t.text == key && p.peek().text == ":" {
			p.pos++
			return true
		}
	}
	return false
}

// value parses a JSON-shaped literal: strings, numbers, booleans, null,
// arrays and objects of those. Anything else is errNotLiteral.
func (p *literalParser) value() (any, error) {
	wrappers := p.skipWrappers()
	v, err := p.plain()
	if err != nil {
		return nil, err
	}
	// "as const", "satisfies T" and closing wrappers are not part of the value.
	for p.peek().text == "as" || p.peek().text == "satisfies" {
		p.pos += 2
	}
	for ; wrappers > 0 && p.peek().text == ")"; wrappers-- {
		p.pos++
	}
	return v, nil
}

func (p *literalParser) plain() (any, error) {
	t := p.next()
	switch t.kind {
	case tString:
		if p.peek().kind == tString || p.peek().text == "+" {
			return nil, errNotLiteral
		}
		if strings.Contains(t.text, "${") {
			return nil, errNotLiteral
		}
		return unquote(t.text), nil
	case tNumber:
		return number(t.text)
	case tIdent:
		switch t.text {
		case "true", "True":
			return true, nil
		case "false", "False":
			return false, nil
		case "null", "None", "undefined":
			return nil, nil
		}
		return nil, errNotLiteral
	}
	switch t.text {
	case "-":
		n := p.next()
		if n.kind != tNumber {
			return nil, errNotLiteral
		}
		v, err := number(n.text)
		if err != nil {
			return nil, err
		}
		return -v, nil
	case "[", "(":
		closer := "]"
		if t.text == "(" {
			closer = ")"
		}
		list := []any{}
		for {
			if p.peek().text == closer {
				p.pos++
				return list, nil
			}
			item, err := p.value()
			if err != nil {
				return nil, err
			}
			list = append(list, item)
			switch p.next().text {
			case ",":
			case closer:
				return list, nil
			default:
				return nil, errNotLiteral
			}
		}
	case "{":
		obj := map[string]any{}
		for {
			if p.peek().text == "}" {
				p.pos++
				return obj, nil
			}
			k := p.next()
			if k.kind != tIdent && k.kind != tString && k.kind != tNumber {
				return nil, errNotLiteral
			}
			if p.next().text != ":" {
				return nil, errNotLiteral
			}
			item, err := p.value()
			if err != nil {
				return nil, err
			}
			obj[unquote(k.text)] = item
			switch p.next().text {
			case ",":
			case "}":
				return obj, nil
			default:
				return nil, errNotLiteral
			}
		}
	}
	return nil, errNotLiteral
}

func number(text string) (float64, error) {
	clean := strings.ReplaceAll(text, "_", "")
	if strings.HasPrefix(clean, "0x") || strings.HasPrefix(clean, "0X") {
		n, err := strconv.ParseInt(clean[2:], 16, 64)
		return float64(n), err
	}
	clean = strings.TrimRight(clean, "nNlLfFdDmM")
	v, err := strconv.ParseFloat(clean, 64)
	if err != nil {
		return 0, errNotLiteral
	}
	return v, nil
}

// wrapperNames are calls that only wrap a literal: Object.freeze([...]),
// tuple([...]).
var wrapperNames = map[string]bool{"Object": true, "freeze": true, "tuple": true, "list": true, "frozenset": true}
