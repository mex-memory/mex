//! Token kinds from TypeScript 5.9.3's `createScanner(...).scan()`.
//!
//! Adapted from TypeScript, Copyright (c) Microsoft Corporation.
//! See `LICENSE-APACHE` and `NOTICE` in this crate.

use std::cmp::Ordering;

include!("scanner_tables.inc.rs");

const LINE_BREAKS: [char; 4] = ['\r', '\n', '\u{2028}', '\u{2029}'];
const MAX_KEYWORD_LENGTH: usize = 12;

/// Return TypeScript's reverse `SyntaxKind` names at `ScriptTarget.Latest`,
/// with trivia skipping enabled and the requested language variant. EOF is
/// omitted. Each call starts at position zero and uses only `scan()`.
pub fn scan_token_names(text: &str, jsx: bool) -> Vec<&'static str> {
    let mut scanner = Scanner { text, pos: 0, jsx };
    let mut names = Vec::new();
    loop {
        let token = scanner.scan();
        if token == Kind::EndOfFileToken {
            return names;
        }
        names.push(token.name());
    }
}

struct Scanner<'a> {
    text: &'a str,
    // Keep a UTF-8 scalar boundary. TypeScript's code-unit lookahead here
    // tests ASCII syntax, and its code-point tests consume a whole scalar.
    pos: usize,
    jsx: bool,
}

impl Scanner<'_> {
    fn scan(&mut self) -> Kind {
        use Kind::*;

        loop {
            let (token, width) = match self.remaining().as_bytes() {
                [] => return EndOfFileToken,
                [b' ' | b'\t' | b'\n' | b'\r' | 0x0b | 0x0c, ..] => {
                    self.pos += 1;
                    continue;
                }
                [b'#', b'!', ..] if self.pos == 0 => {
                    self.skip_line();
                    continue;
                }
                [b'/', b'/', ..] => {
                    self.skip_line();
                    continue;
                }
                [b'/', b'*', ..] => {
                    let body = &self.remaining()[2..];
                    self.pos += 2 + body.find("*/").map_or(body.len(), |end| end + 2);
                    continue;
                }
                [b'<' | b'=' | b'>' | b'|', ..] if self.at_conflict_marker() => {
                    self.skip_conflict_marker();
                    continue;
                }
                // A base prefix requires at least one more code unit of input.
                [b'0', b'x' | b'X', _, ..] => return self.scan_based_number(u8::is_ascii_hexdigit),
                [b'0', b'b' | b'B', _, ..] => {
                    return self.scan_based_number(|digit| matches!(digit, b'0' | b'1'));
                }
                [b'0', b'o' | b'O', _, ..] => {
                    return self.scan_based_number(|digit| (b'0'..=b'7').contains(digit));
                }
                [b'0'..=b'9', ..] | [b'.', b'0'..=b'9', ..] => return self.scan_number(),
                [quote @ (b'\'' | b'"'), ..] => return self.scan_string(*quote),
                [b'`', ..] => return self.scan_template(),
                [b'!', b'=', b'=', ..] => (ExclamationEqualsEqualsToken, 3),
                [b'!', b'=', ..] => (ExclamationEqualsToken, 2),
                [b'!', ..] => (ExclamationToken, 1),
                [b'%', b'=', ..] => (PercentEqualsToken, 2),
                [b'%', ..] => (PercentToken, 1),
                [b'&', b'&', b'=', ..] => (AmpersandAmpersandEqualsToken, 3),
                [b'&', b'&', ..] => (AmpersandAmpersandToken, 2),
                [b'&', b'=', ..] => (AmpersandEqualsToken, 2),
                [b'&', ..] => (AmpersandToken, 1),
                [b'(', ..] => (OpenParenToken, 1),
                [b')', ..] => (CloseParenToken, 1),
                [b'*', b'*', b'=', ..] => (AsteriskAsteriskEqualsToken, 3),
                [b'*', b'*', ..] => (AsteriskAsteriskToken, 2),
                [b'*', b'=', ..] => (AsteriskEqualsToken, 2),
                [b'*', ..] => (AsteriskToken, 1),
                [b'+', b'+', ..] => (PlusPlusToken, 2),
                [b'+', b'=', ..] => (PlusEqualsToken, 2),
                [b'+', ..] => (PlusToken, 1),
                [b',', ..] => (CommaToken, 1),
                [b'-', b'-', ..] => (MinusMinusToken, 2),
                [b'-', b'=', ..] => (MinusEqualsToken, 2),
                [b'-', ..] => (MinusToken, 1),
                [b'.', b'.', b'.', ..] => (DotDotDotToken, 3),
                [b'.', ..] => (DotToken, 1),
                [b'/', b'=', ..] => (SlashEqualsToken, 2),
                [b'/', ..] => (SlashToken, 1),
                [b':', ..] => (ColonToken, 1),
                [b';', ..] => (SemicolonToken, 1),
                [b'<', b'<', b'=', ..] => (LessThanLessThanEqualsToken, 3),
                [b'<', b'<', ..] => (LessThanLessThanToken, 2),
                [b'<', b'=', ..] => (LessThanEqualsToken, 2),
                // This is the language variant's only effect in scan().
                [b'<', b'/', ..] if self.jsx && self.byte(2) != b'*' => (LessThanSlashToken, 2),
                [b'<', ..] => (LessThanToken, 1),
                [b'=', b'=', b'=', ..] => (EqualsEqualsEqualsToken, 3),
                [b'=', b'=', ..] => (EqualsEqualsToken, 2),
                [b'=', b'>', ..] => (EqualsGreaterThanToken, 2),
                [b'=', ..] => (EqualsToken, 1),
                [b'>', ..] => (GreaterThanToken, 1),
                [b'?', b'.', ..] if !self.byte(2).is_ascii_digit() => (QuestionDotToken, 2),
                [b'?', b'?', b'=', ..] => (QuestionQuestionEqualsToken, 3),
                [b'?', b'?', ..] => (QuestionQuestionToken, 2),
                [b'?', ..] => (QuestionToken, 1),
                [b'[', ..] => (OpenBracketToken, 1),
                [b']', ..] => (CloseBracketToken, 1),
                [b'^', b'=', ..] => (CaretEqualsToken, 2),
                [b'^', ..] => (CaretToken, 1),
                [b'{', ..] => (OpenBraceToken, 1),
                [b'|', b'|', b'=', ..] => (BarBarEqualsToken, 3),
                [b'|', b'|', ..] => (BarBarToken, 2),
                [b'|', b'=', ..] => (BarEqualsToken, 2),
                [b'|', ..] => (BarToken, 1),
                [b'}', ..] => (CloseBraceToken, 1),
                [b'~', ..] => (TildeToken, 1),
                [b'@', ..] => (AtToken, 1),
                [b'\\', ..] => {
                    if let Some(token) = self.scan_escaped_identifier() {
                        return token;
                    }
                    (Unknown, 1)
                }
                [b'#', b'!', ..] => (Unknown, 1),
                [b'#', ..] => return self.scan_private_identifier(),
                _ => {
                    let ch = self.remaining().chars().next().expect("nonempty input");
                    if ch == '\u{fffd}' {
                        // The binary-file sentinel survives skipTrivia and ends the scan.
                        self.pos = self.text.len();
                        return NonTextFileMarkerTrivia;
                    }
                    if is_identifier_start(ch) {
                        return self.scan_identifier(ch);
                    }
                    if is_non_ascii_whitespace(ch) {
                        self.pos += ch.len_utf8();
                        continue;
                    }
                    (Unknown, ch.len_utf8())
                }
            };
            self.pos += width;
            return token;
        }
    }

    fn remaining(&self) -> &str {
        &self.text[self.pos..]
    }

    // Lookahead callers compare against non-NUL ASCII syntax or digit ranges.
    fn byte(&self, offset: usize) -> u8 {
        self.text
            .as_bytes()
            .get(self.pos + offset)
            .copied()
            .unwrap_or(0)
    }

    fn eat(&mut self, byte: u8) -> bool {
        if self.byte(0) == byte {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    fn advance_char(&mut self) {
        self.pos += self
            .remaining()
            .chars()
            .next()
            .expect("nonempty input")
            .len_utf8();
    }

    fn skip_line(&mut self) {
        let rest = self.remaining();
        self.pos += rest.find(LINE_BREAKS).unwrap_or(rest.len());
    }

    fn at_conflict_marker(&self) -> bool {
        let Some(prefix) = self.remaining().as_bytes().get(..8) else {
            return false;
        };
        let marker = prefix[0];
        (marker == b'=' || prefix[7] == b' ')
            && prefix[..7].iter().all(|&byte| byte == marker)
            && (self.pos == 0 || self.text[..self.pos].ends_with(LINE_BREAKS))
    }

    fn skip_conflict_marker(&mut self) {
        let marker = self.byte(0);
        self.skip_line();
        if matches!(marker, b'<' | b'>') {
            return;
        }
        // A base or separator marker skips full lines until the next marker
        // of the appropriate kind, including anything that looks like code.
        while self.pos < self.text.len() {
            self.advance_char();
            let next = self.byte(0);
            if next != marker && matches!(next, b'=' | b'>') && self.at_conflict_marker() {
                break;
            }
            self.skip_line();
        }
    }

    fn scan_string(&mut self, quote: u8) -> Kind {
        self.pos += 1;
        loop {
            match self.remaining().as_bytes() {
                [] | [b'\r' | b'\n', ..] => break,
                [first, ..] if *first == quote => {
                    self.pos += 1;
                    break;
                }
                [b'\\', ..] => self.skip_escape(),
                _ => self.advance_char(),
            }
        }
        Kind::StringLiteral
    }

    fn scan_template(&mut self) -> Kind {
        self.pos += 1;
        loop {
            match self.remaining().as_bytes() {
                [] => return Kind::NoSubstitutionTemplateLiteral,
                [b'`', ..] => {
                    self.pos += 1;
                    return Kind::NoSubstitutionTemplateLiteral;
                }
                [b'$', b'{', ..] => {
                    self.pos += 2;
                    return Kind::TemplateHead;
                }
                [b'\\', ..] => self.skip_escape(),
                _ => self.advance_char(),
            }
        }
    }

    fn skip_escape(&mut self) {
        // scanEscapeSequence uses the same cursor movement for strings and
        // templates. The cooked value and error flags do not affect scan().
        self.pos += 1;
        match self.remaining().as_bytes() {
            [] => {}
            [b'u', b'{', ..] => {
                self.pos += 2;
                self.skip_ascii(usize::MAX, u8::is_ascii_hexdigit);
                self.eat(b'}');
            }
            [b'u', ..] => {
                self.pos += 1;
                self.skip_ascii(4, u8::is_ascii_hexdigit);
            }
            [b'x', ..] => {
                self.pos += 1;
                self.skip_ascii(2, u8::is_ascii_hexdigit);
            }
            [digit @ b'0'..=b'7', ..] => {
                let extra = if *digit <= b'3' { 2 } else { 1 };
                self.pos += 1;
                self.skip_ascii(extra, |byte| (b'0'..=b'7').contains(byte));
            }
            [b'\r', b'\n', ..] => self.pos += 2,
            _ => self.advance_char(),
        }
    }

    fn skip_ascii(&mut self, limit: usize, predicate: impl FnMut(&u8) -> bool) {
        self.pos += self
            .remaining()
            .bytes()
            .take(limit)
            .take_while(predicate)
            .count();
    }

    fn scan_based_number(&mut self, is_digit: impl Fn(&u8) -> bool) -> Kind {
        self.pos += 2;
        self.skip_ascii(usize::MAX, |byte| *byte == b'_' || is_digit(byte));
        self.scan_bigint_suffix()
    }

    fn skip_decimal_fragment(&mut self) {
        self.skip_ascii(usize::MAX, |byte| byte.is_ascii_digit() || *byte == b'_');
    }

    fn scan_number(&mut self) -> Kind {
        let mut leading_zero_decimal = false;
        if self.byte(0) == b'0' && self.byte(1) != b'_' {
            self.pos += 1;
            let start = self.pos;
            let mut octal = true;
            while let digit @ b'0'..=b'9' = self.byte(0) {
                octal &= digit <= b'7';
                self.pos += 1;
            }
            if self.pos != start {
                if octal {
                    // Legacy octal returns before consuming a fraction or exponent.
                    return Kind::NumericLiteral;
                }
                leading_zero_decimal = true;
            }
        } else {
            self.skip_decimal_fragment();
        }

        let decimal = self.eat(b'.');
        if decimal {
            self.skip_decimal_fragment();
        }
        let scientific = matches!(self.byte(0), b'e' | b'E');
        if scientific {
            self.pos += 1;
            if matches!(self.byte(0), b'+' | b'-') {
                self.pos += 1;
            }
            self.skip_decimal_fragment();
        }
        if leading_zero_decimal {
            return Kind::NumericLiteral;
        }
        let token = if decimal || scientific {
            Kind::NumericLiteral
        } else {
            self.scan_bigint_suffix()
        };
        self.skip_numeric_identifier_suffix();
        token
    }

    fn scan_bigint_suffix(&mut self) -> Kind {
        if self.eat(b'n') {
            Kind::BigIntLiteral
        } else {
            Kind::NumericLiteral
        }
    }

    fn skip_numeric_identifier_suffix(&mut self) {
        // checkForIdentifierStartAfterNumericLiteral rewinds except when the
        // raw spelling starts with n and the cooked spelling is one UTF-16 unit.
        if self.byte(0) == b'n' {
            let start = self.pos;
            let mut spelling = IdentifierSpelling::default();
            self.scan_identifier_parts(&mut spelling);
            if !spelling.is_single_utf16_unit() {
                self.pos = start;
            }
        }
    }

    fn scan_private_identifier(&mut self) -> Kind {
        self.pos += 1;
        if self.byte(0) == b'\\' {
            let _ = self.scan_escaped_identifier();
        } else if let Some(ch) = self
            .remaining()
            .chars()
            .next()
            .filter(|&ch| is_identifier_start(ch))
        {
            self.scan_identifier(ch);
        }
        Kind::PrivateIdentifier
    }

    fn scan_identifier(&mut self, first: char) -> Kind {
        let start = self.pos;
        self.pos += first.len_utf8();
        self.skip_identifier_run();
        if self.byte(0) != b'\\' {
            return identifier_token(&self.text.as_bytes()[start..self.pos]);
        }
        // scanIdentifier keeps this first unescaped run before delegating to
        // scanIdentifierParts, which handles the rest differently.
        let mut spelling = IdentifierSpelling::default();
        spelling.push(&self.text[start..self.pos]);
        self.scan_identifier_parts(&mut spelling);
        spelling.token()
    }

    fn scan_escaped_identifier(&mut self) -> Option<Kind> {
        let escape = self
            .peek_identifier_escape()
            .filter(|escape| is_identifier_start(escape.ch))?;
        let mut spelling = IdentifierSpelling::default();
        self.take_identifier_escape(escape, &mut spelling);
        self.scan_identifier_parts(&mut spelling);
        Some(spelling.token())
    }

    fn skip_identifier_run(&mut self) {
        let rest = self.remaining();
        self.pos += rest
            .find(|ch| !is_identifier_part(ch))
            .unwrap_or(rest.len());
    }

    fn scan_identifier_parts(&mut self, spelling: &mut IdentifierSpelling) {
        loop {
            let start = self.pos;
            self.skip_identifier_run();
            let escape = self
                .peek_identifier_escape()
                .filter(|escape| is_identifier_part(escape.ch));
            // Accepting a braced escape discards the preceding unflushed run
            // in scanIdentifierParts. Other paths keep it.
            if !escape.as_ref().is_some_and(|escape| escape.extended) {
                spelling.push(&self.text[start..self.pos]);
            }
            let Some(escape) = escape else { break };
            self.take_identifier_escape(escape, spelling);
        }
    }

    fn peek_identifier_escape(&self) -> Option<IdentifierEscape> {
        let rest = self.remaining().strip_prefix("\\u")?;
        if let Some(body) = rest.strip_prefix('{') {
            let digits = body.bytes().take_while(u8::is_ascii_hexdigit).count();
            let ch = char::from_u32(u32::from_str_radix(&body[..digits], 16).ok()?)?;
            // The compiler's peek checks the digits without requiring `}`.
            let closed = body.as_bytes().get(digits) == Some(&b'}');
            return Some(IdentifierEscape {
                ch,
                width: 3 + digits + usize::from(closed),
                extended: true,
                unterminated: !closed,
            });
        }
        let digits = rest.get(..4)?;
        if !digits.as_bytes().iter().all(u8::is_ascii_hexdigit) {
            return None;
        }
        let ch = char::from_u32(u32::from_str_radix(digits, 16).ok()?)?;
        Some(IdentifierEscape {
            ch,
            width: 6,
            extended: false,
            unterminated: false,
        })
    }

    fn take_identifier_escape(
        &mut self,
        escape: IdentifierEscape,
        spelling: &mut IdentifierSpelling,
    ) {
        let end = self.pos + escape.width;
        if escape.unterminated {
            spelling.push(&self.text[self.pos..end]);
        } else {
            spelling.push(escape.ch.encode_utf8(&mut [0; 4]));
        }
        self.pos = end;
    }
}

struct IdentifierEscape {
    ch: char,
    width: usize,
    extended: bool,
    unterminated: bool,
}

// Only keywords and the one-unit numeric suffix need a cooked spelling.
// ASCII keywords fit here, as do all scalars with one UTF-16 code unit.
#[derive(Default)]
struct IdentifierSpelling {
    bytes: [u8; MAX_KEYWORD_LENGTH],
    len: usize,
}

impl IdentifierSpelling {
    fn push(&mut self, fragment: &str) {
        let start = self.len;
        self.len += fragment.len();
        if let Some(out) = self.bytes.get_mut(start..self.len) {
            out.copy_from_slice(fragment.as_bytes());
        }
    }

    fn token(&self) -> Kind {
        self.bytes
            .get(..self.len)
            .map_or(Kind::Identifier, identifier_token)
    }

    fn is_single_utf16_unit(&self) -> bool {
        self.len <= 3
            && std::str::from_utf8(&self.bytes[..self.len])
                .is_ok_and(|text| text.chars().count() == 1)
    }
}

fn identifier_token(bytes: &[u8]) -> Kind {
    if (2..=MAX_KEYWORD_LENGTH).contains(&bytes.len()) && bytes[0].is_ascii_lowercase() {
        keyword(bytes)
    } else {
        Kind::Identifier
    }
}

fn is_identifier_start(ch: char) -> bool {
    ch.is_ascii_alphabetic()
        || matches!(ch, '_' | '$')
        || in_unicode_ranges(ch, UNICODE_IDENTIFIER_START)
}

fn is_identifier_part(ch: char) -> bool {
    ch.is_ascii_alphanumeric()
        || matches!(ch, '_' | '$')
        || in_unicode_ranges(ch, UNICODE_IDENTIFIER_PART)
}

fn in_unicode_ranges(ch: char, ranges: &[(u32, u32)]) -> bool {
    let code = u32::from(ch);
    !ch.is_ascii()
        && ranges
            .binary_search_by(|&(first, last)| {
                if last < code {
                    Ordering::Less
                } else if first > code {
                    Ordering::Greater
                } else {
                    Ordering::Equal
                }
            })
            .is_ok()
}

fn is_non_ascii_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\u{0085}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200b}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}
