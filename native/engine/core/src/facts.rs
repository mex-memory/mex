//! The facts contract: what one file contributes to the graph before any
//! cross-file resolution.
//!
//! Every adapter produces a [`FileFacts`] per file and the resolver reads only
//! facts, never syntax trees, so a file's tree is freed as soon as its facts
//! exist and facts are the unit the cache stores. The shape starts from the
//! mex-platform engine's facts (`packages/codegraph/src/facts.ts`) and adds
//! what the OSS graph needs: identity inputs, body hashes and fingerprint
//! tokens, framework markers, and hard bounds.
//!
//! Indices: `defs`, `scopes` and `calls` refer to each other by position in
//! their own vector; `-1` (as [`NONE`]) means the file or the module scope.
//! Positions are UTF-8 byte offsets plus a 0-based line and a column in
//! UTF-16 code units: the unit today's graph stores (web-tree-sitter indexes a
//! JavaScript string), so spans read the same whichever engine wrote them.

use serde::{Deserialize, Serialize};

pub mod ecmascript;

/// Bumped on incompatible changes to these types; part of the facts cache key.
pub const FACTS_VERSION: u32 = 1;

/// "No index": the module scope, or the file as a definition's parent.
pub const NONE: i32 = -1;

/// Hard bounds: a file that reaches one records a diagnostic instead of
/// growing without limit (graph-01 once rendered a 914k-character signature).
pub mod bounds {
    pub const MAX_DEFS: usize = 20_000;
    pub const MAX_CALLS: usize = 100_000;
    pub const MAX_SIGNATURE_BYTES: usize = 1_024;
    pub const MAX_CALLEE_TEXT_BYTES: usize = 256;
    pub const MAX_DOCSTRING_BYTES: usize = 2_048;
    /// Today's file rows keep the first 100 parse issues.
    pub const MAX_DIAGNOSTICS: usize = 100;
}

/// A source range: bytes, then 0-based start line and column, end line and column.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Range {
    pub start_byte: u32,
    pub end_byte: u32,
    pub start_line: u32,
    pub start_col: u32,
    pub end_line: u32,
    pub end_col: u32,
}

/// The node kinds today's graph stores (`NODE_KINDS` in `src/graph/types.ts`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    File,
    Module,
    Class,
    Struct,
    Interface,
    Trait,
    Protocol,
    Function,
    Method,
    Property,
    Field,
    Variable,
    Constant,
    Enum,
    EnumMember,
    TypeAlias,
    Namespace,
    Parameter,
    Import,
    Export,
    Route,
    Component,
}

impl Kind {
    /// The kind's name as it appears in node ids and the `nodes.kind` column.
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::File => "file",
            Kind::Module => "module",
            Kind::Class => "class",
            Kind::Struct => "struct",
            Kind::Interface => "interface",
            Kind::Trait => "trait",
            Kind::Protocol => "protocol",
            Kind::Function => "function",
            Kind::Method => "method",
            Kind::Property => "property",
            Kind::Field => "field",
            Kind::Variable => "variable",
            Kind::Constant => "constant",
            Kind::Enum => "enum",
            Kind::EnumMember => "enum_member",
            Kind::TypeAlias => "type_alias",
            Kind::Namespace => "namespace",
            Kind::Parameter => "parameter",
            Kind::Import => "import",
            Kind::Export => "export",
            Kind::Route => "route",
            Kind::Component => "component",
        }
    }
}

/// Everything one file contributes, before resolution.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct FileFacts {
    pub facts_version: u32,
    /// Repository-relative path with `/` separators.
    pub path: String,
    pub language: String,
    /// SHA-256 of the file's exact bytes.
    pub content_hash: [u8; 32],
    pub scopes: Vec<Scope>,
    pub defs: Vec<Def>,
    pub imports: Vec<Import>,
    pub exports: Vec<Export>,
    pub calls: Vec<Call>,
    pub bindings: Vec<Binding>,
    pub frameworks: Vec<FrameworkMarker>,
    pub health: Health,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ecmascript: Option<ecmascript::ReferenceFacts>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub syntax_references: Vec<SyntaxReference>,
}

/// A written symbol reference from an adapter with syntax-only resolution.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SyntaxReference {
    pub from: usize,
    pub kind: ReferenceKind,
    pub name: String,
    pub range: Range,
    /// The callee of a syntactic call receiver such as `make().run()`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receiver_call: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReferenceKind {
    Calls,
    Decorates,
    Extends,
    Implements,
    Instantiates,
    Returns,
    TypeOf,
}

impl ReferenceKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Calls => "calls",
            Self::Decorates => "decorates",
            Self::Extends => "extends",
            Self::Implements => "implements",
            Self::Instantiates => "instantiates",
            Self::Returns => "returns",
            Self::TypeOf => "type_of",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScopeKind {
    Function,
    Arrow,
    Block,
    Class,
    Comprehension,
    Module,
}

/// A lexical scope. Class scopes hold members; names bound there are not
/// visible to nested functions (true in Python and in ECMAScript method bodies).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Scope {
    pub kind: ScopeKind,
    pub parent: i32,
    /// The definition that owns this scope, or [`NONE`].
    pub def: i32,
    /// ECMAScript: whether `this` is the class (static) or an instance.
    pub this_static: Option<bool>,
}

/// A declaration, and the inputs of its node id.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Def {
    pub kind: Kind,
    pub name: String,
    /// Dotted or `::`-joined name as the language's id profile expects it.
    pub qualified_name: String,
    /// The id's declaration role (`function-assignment`, `framework:flask`, ...);
    /// `None` means the kind.
    pub declaration_role: Option<String>,
    /// Normalized signature, bounded by [`bounds::MAX_SIGNATURE_BYTES`].
    pub signature: String,
    /// Overload ordinal, for the ordinal id profile.
    pub ordinal: Option<u32>,
    pub parent: i32,
    /// Scope the name is bound in.
    pub scope: i32,
    pub range: Range,
    pub name_range: Range,
    pub exported: bool,
    pub is_default_export: bool,
    /// Modifiers that change call semantics: `static`, `async`, `abstract`,
    /// Python decorators such as `staticmethod`.
    pub flags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visibility: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub decorators: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub type_parameters: Vec<String>,
    /// Base classes and implemented interfaces, as written.
    pub heritage: Vec<Heritage>,
    pub return_type: Option<String>,
    /// SHA-256 of the normalized body, for drift checks.
    pub body_hash: Option<[u8; 32]>,
    /// The MinHash sketch of the definition's syntax tokens, computed while
    /// its tree is still alive so the tree can be freed straight after.
    pub sketch: Option<SketchFacts>,
    pub docstring: Option<String>,
}

/// A definition's sketch: 64 minima and the number of tokens behind them.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SketchFacts {
    pub minhash: Vec<u32>,
    pub token_count: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Heritage {
    pub implements: bool,
    pub name: String,
    pub range: Range,
}

/// One name an import binds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ImportBinding {
    /// `default`, `*` or a symbol name.
    pub imported: String,
    /// Local name, or `None` for side-effect imports and re-exports.
    pub local: Option<String>,
    /// Re-exports: the exported name (`*` for `export *`).
    pub exported: Option<String>,
    #[serde(default, skip_serializing_if = "is_false")]
    pub type_only: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportForm {
    Es,
    CommonJs,
    Reexport,
    Python,
    RustUse,
    CSharpUsing,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Import {
    pub form: ImportForm,
    /// The specifier as written, or Python's dotted module path.
    pub specifier: String,
    /// Python relative level (leading dots); 0 otherwise.
    pub level: u32,
    pub bindings: Vec<ImportBinding>,
    pub scope: i32,
    pub range: Range,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Export {
    pub local: Option<String>,
    pub def: i32,
    pub exported: String,
    #[serde(default, skip_serializing_if = "is_false")]
    pub type_only: bool,
    pub range: Range,
}

fn is_false(value: &bool) -> bool {
    !*value
}

/// What a call is made on: the evidence the resolver types receivers from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Receiver {
    This,
    Super,
    Name {
        name: String,
    },
    ThisMember {
        name: String,
    },
    Path {
        path: Vec<String>,
    },
    /// A call result, resolved only through a declared return type.
    CallResult {
        name: String,
        receiver: Option<Box<Receiver>>,
    },
    /// A literal of a built-in type (`[].map`, `"".join`).
    Builtin {
        name: String,
    },
    /// A reference into the ECMAScript expression arena.
    Expression {
        index: ecmascript::ExprId,
    },
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CallForm {
    Ident,
    Member,
    New,
    SuperConstructor,
    Other,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Call {
    pub form: CallForm,
    /// The called name (identifier, member or constructor).
    pub name: String,
    pub receiver: Option<Receiver>,
    pub scope: i32,
    /// The enclosing definition (the caller), or [`NONE`] for the file.
    pub caller: i32,
    pub range: Range,
    /// Where the called name is written: the edge's line and column.
    pub name_range: Range,
    /// Callee text for unresolved reporting, bounded by
    /// [`bounds::MAX_CALLEE_TEXT_BYTES`].
    pub text: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TypeBasis {
    Annotation,
    Constructor,
    Call,
    /// A variable initialised from `this` and never reassigned.
    This,
}

/// A local name, for shadowing and receiver typing.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Binding {
    pub name: String,
    pub scope: i32,
    pub param: bool,
    /// Declared or inferred type, and the evidence for it.
    pub type_name: Option<String>,
    pub type_basis: Option<TypeBasis>,
    /// Class fields: the owning class definition.
    pub field_of: Option<i32>,
}

/// Something a framework resolver reads: a decorator, a route registration,
/// a dependency-injection marker.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct FrameworkMarker {
    pub kind: String,
    pub name: String,
    pub arguments: Vec<String>,
    pub def: i32,
    pub range: Range,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ParseStatus {
    #[default]
    Ok,
    Partial,
    Failed,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Health {
    pub status: ParseStatus,
    pub error_count: u32,
    pub missing_count: u32,
    /// Share of the file's bytes inside error nodes.
    pub error_coverage: f32,
    /// At most [`bounds::MAX_DIAGNOSTICS`] locations.
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub code: String,
    pub range: Range,
}

impl Def {
    /// This definition's identity under the signature profile (the
    /// tree-sitter route's recipe), for a file at `path`.
    pub fn signature_identity(&self, path: &str) -> String {
        crate::id::signature_identity(
            path,
            self.kind.as_str(),
            &self.qualified_name,
            self.declaration_role.as_deref(),
            &self.signature,
        )
    }

    /// The public text id under the signature profile.
    pub fn signature_id(&self, path: &str) -> String {
        crate::id::node_id(self.kind.as_str(), &self.signature_identity(path))
    }

    /// This definition's identity under the compiler route's ordinal profile.
    pub fn ordinal_identity(&self, path: &str) -> String {
        let kind = self.kind.as_str();
        crate::id::ordinal_identity(
            path,
            kind,
            &self.qualified_name,
            self.declaration_role.as_deref().unwrap_or(kind),
            self.ordinal,
        )
    }

    /// The public text id under the ordinal profile.
    pub fn ordinal_id(&self, path: &str) -> String {
        crate::id::node_id(self.kind.as_str(), &self.ordinal_identity(path))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kind_names_match_todays_graph() {
        for kind in [
            Kind::File,
            Kind::EnumMember,
            Kind::TypeAlias,
            Kind::Component,
        ] {
            let json = serde_json::to_string(&kind).unwrap();
            assert_eq!(json, format!("\"{}\"", kind.as_str()));
        }
    }

    #[test]
    fn facts_round_trip_through_json() {
        let facts = FileFacts {
            facts_version: FACTS_VERSION,
            path: "src/app.py".into(),
            language: "python".into(),
            calls: vec![Call {
                form: CallForm::Member,
                name: "request".into(),
                receiver: Some(Receiver::CallResult {
                    name: "client".into(),
                    receiver: Some(Box::new(Receiver::This)),
                }),
                scope: NONE,
                caller: NONE,
                range: Range::default(),
                name_range: Range::default(),
                text: "self.client().request".into(),
            }],
            ..FileFacts::default()
        };
        let json = serde_json::to_string(&facts).unwrap();
        assert_eq!(serde_json::from_str::<FileFacts>(&json).unwrap(), facts);
    }
}
