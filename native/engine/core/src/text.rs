//! Text the way today's TypeScript pipeline measures it.
//!
//! web-tree-sitter parses a JavaScript string, so every stored column is in
//! UTF-16 code units and every cut (`text.slice(0, 200)`) counts UTF-16 units.
//! Native tree-sitter reports UTF-8 bytes. These helpers convert, so stored
//! spans and signatures equal today's on lines that aren't ASCII.

use crate::id::is_js_whitespace;

/// `String.prototype.trim`.
pub fn js_trim(value: &str) -> &str {
    value.trim_matches(is_js_whitespace)
}

/// The UTF-16 column of byte offset `byte_col` within `line`.
pub fn utf16_column(line: &str, byte_col: usize) -> u32 {
    let end = byte_col.min(line.len());
    let mut units = 0u32;
    for (offset, c) in line.char_indices() {
        if offset >= end {
            break;
        }
        units += c.len_utf16() as u32;
    }
    units
}

/// `value.slice(0, max_units)`: the first `max_units` UTF-16 code units. A cut
/// through a surrogate pair leaves a lone surrogate in JavaScript, which
/// becomes U+FFFD once encoded as UTF-8 (hashed, or written to SQLite).
pub fn js_slice(value: &str, max_units: usize) -> String {
    let mut out = String::new();
    let mut units = 0;
    for c in value.chars() {
        let width = c.len_utf16();
        if units + width > max_units {
            if units < max_units {
                out.push('\u{FFFD}');
            }
            break;
        }
        out.push(c);
        units += width;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn columns_count_utf16_units() {
        assert_eq!(utf16_column("abc", 2), 2);
        // "é" is 2 bytes and 1 unit; "😀" is 4 bytes and 2 units.
        assert_eq!(utf16_column("é😀x", 2), 1);
        assert_eq!(utf16_column("é😀x", 6), 3);
        assert_eq!(utf16_column("é😀x", 99), 4);
    }

    #[test]
    fn slices_like_javascript() {
        assert_eq!(js_slice("hello", 3), "hel");
        assert_eq!(js_slice("a😀b", 2), "a\u{FFFD}");
        assert_eq!(js_slice("a😀b", 3), "a😀");
        assert_eq!(js_slice("ab", 10), "ab");
    }

    #[test]
    fn trims_javascript_whitespace_only() {
        assert_eq!(js_trim("\u{FEFF} x \u{3000}"), "x");
        assert_eq!(js_trim("\u{0085}x"), "\u{0085}x");
    }
}
