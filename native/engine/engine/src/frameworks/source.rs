//! Line scanners preserve the sites and literal handling of the v4 resolvers.

use mex_graph_core::text::js_trim;

macro_rules! rx {
    ($pattern:literal) => {{
        static PATTERN: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
            // JS \s includes the BOM, and omits NEXT LINE.
            const SPACE: &str = r"\t\n\x0B\x0C\r \x{00A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";
            regex::Regex::new(&$pattern.replace(r"[\s]", &format!("[{SPACE}]"))
                .replace(r"\s", &format!("[{SPACE}]")))
                .expect("a framework regex")
        });
        &*PATTERN
    }};
}

pub(super) use rx;

pub(super) fn ecmascript_extension(path: &str) -> bool {
    path.rsplit_once('.').is_some_and(|(_, ext)| {
        matches!(
            ext,
            "ts" | "tsx" | "mts" | "cts" | "js" | "jsx" | "mjs" | "cjs"
        )
    })
}

/// Read a balanced call, returning its arguments and the end of its closing
/// delimiter. Quotes retain the legacy scanners' backslash behavior.
pub(super) fn balanced(text: &str, open: usize, templates: bool) -> Option<(&str, usize)> {
    let mut depth = 0;
    let mut quote = None;
    let bytes = text.as_bytes();
    for (i, &ch) in bytes.iter().enumerate().skip(open) {
        if let Some(delimiter) = quote {
            if ch == delimiter && bytes[i - 1] != b'\\' {
                quote = None;
            }
        } else if matches!(ch, b'\'' | b'"') || (templates && ch == b'`') {
            quote = Some(ch);
        } else if ch == b'(' {
            depth += 1;
        } else if ch == b')' {
            depth -= 1;
            if depth == 0 {
                return Some((&text[open + 1..i], i + 1));
            }
        }
    }
    None
}

/// Blank comments and (for Python) triple-quoted strings. Keep code and
/// string literals and preserve UTF-16 widths for reported columns.
pub(super) fn blank_comments(source: &str, python: bool) -> String {
    enum State {
        Code,
        Comment,
        Block,
        Quoted(char),
        Triple(char),
    }
    let mut state = State::Code;
    let mut result = String::with_capacity(source.len());
    let mut chars = source.char_indices().peekable();
    while let Some((i, ch)) = chars.next() {
        let escaped = i > 0 && source.as_bytes()[i - 1] == b'\\';
        let triple = matches!(ch, '\'' | '"')
            && source
                .as_bytes()
                .get(i..i + 3)
                .is_some_and(|triple| triple == [ch as u8; 3]);
        match state {
            State::Code if python && triple => {
                result.push_str("   ");
                chars.next();
                chars.next();
                state = State::Triple(ch);
            }
            State::Code if python && ch == '#' => {
                result.push(' ');
                state = State::Comment;
            }
            State::Code
                if !python
                    && ch == '/'
                    && chars
                        .peek()
                        .is_some_and(|&(_, next)| matches!(next, '/' | '*')) =>
            {
                let next = chars.next().unwrap().1;
                result.push_str("  ");
                state = if next == '/' {
                    State::Comment
                } else {
                    State::Block
                };
            }
            State::Code => {
                result.push(ch);
                if matches!(ch, '\'' | '"') || (!python && ch == '`') {
                    state = State::Quoted(ch);
                }
            }
            State::Quoted(delimiter) => {
                result.push(ch);
                if (ch == delimiter && !escaped) || (python && ch == '\n') {
                    state = State::Code;
                }
            }
            State::Comment if ch == '\n' => {
                result.push(ch);
                state = State::Code;
            }
            State::Block if ch == '*' && chars.peek().is_some_and(|&(_, next)| next == '/') => {
                result.push_str("  ");
                chars.next();
                state = State::Code;
            }
            State::Triple(delimiter) if ch == delimiter && triple && !escaped => {
                result.push_str("   ");
                chars.next();
                chars.next();
                state = State::Code;
            }
            _ if ch == '\n' => result.push(ch),
            _ => result.extend(std::iter::repeat_n(' ', ch.len_utf16())),
        }
    }
    result
}

pub(super) fn path(prefix: &str, suffix: &str, nest: bool) -> String {
    let prefix = prefix.trim_end_matches('/');
    let mut result = String::new();
    for part in [prefix, suffix] {
        if part.is_empty() || (nest && part == "/") {
            continue;
        }
        if !part.starts_with('/') {
            result.push('/');
        }
        result.push_str(part);
    }
    if result.is_empty() {
        result.push('/');
    } else if nest && result.len() > 1 && result.ends_with('/') {
        result.pop();
    }
    result
}

/// First static path literal. Legacy patterns exclude either quote character
/// from the body, except as an escape in Python.
pub(super) fn quoted(text: &str, templates: bool, escapes: bool) -> Option<&str> {
    let text = js_trim(text);
    let delimiter = *text.as_bytes().first()?;
    if !matches!(delimiter, b'\'' | b'"') && !(templates && delimiter == b'`') {
        return None;
    }
    let mut chars = text.char_indices().skip(1);
    while let Some((i, ch)) = chars.next() {
        if ch as u32 == u32::from(delimiter) {
            let path = &text[1..i];
            return (!(delimiter == b'`' && path.contains("${"))).then_some(path);
        }
        if ch == '\\' && escapes {
            let (_, escaped) = chars.next()?;
            if matches!(escaped, '\n' | '\r' | '\u{2028}' | '\u{2029}') {
                return None;
            }
        } else if matches!(ch, '\'' | '"' | '\\') {
            return None;
        }
    }
    None
}
