//! Node identity: the graph-01 id scheme, byte for byte.
//!
//! A node id is `kind:` followed by the first 32 hex characters of the SHA-256
//! of a canonical identity string. Grounded documentation anchors to these ids,
//! so they must equal what the TypeScript pipeline produced for the same
//! declaration, and they never include a line number.
//!
//! Two recipes exist today, and each adapter declares which one it uses:
//!
//! * [`Profile::Signature`], the tree-sitter route (`canonicalNodeIdentity` in
//!   `src/graph/extraction/node-id.ts`): path, kind, qualified name,
//!   declaration role and signature. Overloads differ by signature.
//! * [`Profile::Ordinal`], the compiler route (`canonicalCompilerIdentity` in
//!   `src/graph/extraction/compiler.ts`): path, kind, qualified name and
//!   declaration role, plus `ordinal:N` in source order when the rest repeats.
//!
//! Whitespace is JavaScript's: `\s` and `String.prototype.trim` match a fixed
//! set that differs from [`char::is_whitespace`] (which adds U+0085 and leaves
//! out U+FEFF). The shared vectors in `tests/id-vectors.json` pin both sides.

use sha2::{Digest, Sha256};

/// Which canonical identity recipe a language uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Profile {
    /// Path, kind, qualified name, declaration role, signature.
    Signature,
    /// Path, kind, qualified name, declaration role, then an overload ordinal.
    Ordinal,
}

/// The characters JavaScript's `\s` and `trim()` treat as whitespace:
/// WhiteSpace (TAB, VT, FF, SP, NBSP, ZWNBSP and the Zs category) and
/// LineTerminator (LF, CR, LS, PS).
pub fn is_js_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{000B}' | '\u{000C}' | '\r' | ' ' | '\u{00A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

/// `value.replace(/\s+/gu, " ").trim()`: each run of whitespace becomes one
/// space, and leading and trailing whitespace is removed.
pub fn collapse_whitespace(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut pending_space = false;
    for c in value.chars() {
        if is_js_whitespace(c) {
            pending_space = !out.is_empty();
        } else {
            if pending_space {
                out.push(' ');
                pending_space = false;
            }
            out.push(c);
        }
    }
    out
}

/// The tree-sitter route's identity: `canonicalNodeIdentity`.
/// `declaration_role` defaults to the kind when the extractor names none.
pub fn signature_identity(
    file_path: &str,
    kind: &str,
    qualified_name: &str,
    declaration_role: Option<&str>,
    signature: &str,
) -> String {
    [
        file_path.replace('\\', "/").as_str(),
        kind,
        collapse_whitespace(qualified_name).as_str(),
        declaration_role.unwrap_or(kind),
        collapse_whitespace(signature).as_str(),
    ]
    .join("\0")
}

/// The compiler route's identity: `canonicalCompilerIdentity`. The path loses
/// a leading `./`, the qualified name is collapsed per `::` segment, and an
/// ordinal tells repeated declarations apart in source order.
pub fn ordinal_identity(
    file_path: &str,
    kind: &str,
    qualified_name: &str,
    declaration_role: &str,
    ordinal: Option<u32>,
) -> String {
    let path = file_path.replace('\\', "/");
    let path = path.strip_prefix("./").unwrap_or(&path);
    let name = qualified_name
        .split("::")
        .map(collapse_whitespace)
        .collect::<Vec<_>>()
        .join("::");
    let base = [path, kind, &name, &collapse_whitespace(declaration_role)].join("\0");
    match ordinal {
        Some(n) => format!("{base}\0ordinal:{n}"),
        None => base,
    }
}

/// The 16 bytes an id's hex names: the first half of the identity's SHA-256.
/// The graph stores this form; the text form is rendered at the boundary.
pub fn id_bytes(identity: &str) -> [u8; 16] {
    let digest = Sha256::digest(identity.as_bytes());
    let mut out = [0u8; 16];
    out.copy_from_slice(&digest[..16]);
    out
}

/// The public text id: `kind:` + 32 lowercase hex characters.
pub fn node_id(kind: &str, identity: &str) -> String {
    let mut out = String::with_capacity(kind.len() + 33);
    out.push_str(kind);
    out.push(':');
    for byte in id_bytes(identity) {
        out.push(char::from(b"0123456789abcdef"[usize::from(byte >> 4)]));
        out.push(char::from(b"0123456789abcdef"[usize::from(byte & 15)]));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapses_like_javascript() {
        assert_eq!(collapse_whitespace("  a \t\n b  "), "a b");
        assert_eq!(collapse_whitespace("\u{FEFF}a\u{3000}b\u{00A0}"), "a b");
        // U+0085 is whitespace to Rust but not to JavaScript.
        assert_eq!(collapse_whitespace("a\u{0085}b"), "a\u{0085}b");
        assert_eq!(collapse_whitespace(""), "");
        assert_eq!(collapse_whitespace(" \t "), "");
    }

    #[test]
    fn ordinal_profile_normalizes_path_and_segments() {
        let identity = ordinal_identity("./src\\a.ts", "function", "A :: b", " role ", Some(2));
        assert_eq!(identity, "src/a.ts\0function\0A::b\0role\0ordinal:2");
    }

    #[test]
    fn signature_profile_defaults_role_to_kind() {
        let identity = signature_identity("pkg\\m.py", "method", "C.m", None, "(self,  x)");
        assert_eq!(identity, "pkg/m.py\0method\0C.m\0method\0(self, x)");
    }

    #[test]
    fn id_is_kind_and_32_hex() {
        let id = node_id("function", "x");
        assert_eq!(id.len(), "function:".len() + 32);
        assert!(id.starts_with("function:2d711642b726b04401627ca9fbac32f5"));
    }
}
