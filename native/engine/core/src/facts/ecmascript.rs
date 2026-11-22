//! Evidence that depends on ECMAScript's separate type and value namespaces,
//! object members, and callable values. Expression indices are local to a file.

use bincode::{Decode, Encode};
use serde::{Deserialize, Serialize};

use super::Range;

pub type ExprId = u32;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Encode, Decode)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Expression {
    Name {
        name: String,
    },
    TypeName {
        name: String,
    },
    GenericType {
        name: String,
        arguments: Vec<Option<ExprId>>,
    },
    Intersection {
        parts: Vec<ExprId>,
    },
    Member {
        object: ExprId,
        name: String,
    },
    Index {
        object: ExprId,
    },
    Call {
        callee: ExprId,
    },
    New {
        callee: ExprId,
    },
    Await {
        operand: ExprId,
    },
    Array {
        element: Option<ExprId>,
    },
    Tuple {
        elements: Vec<Option<ExprId>>,
    },
    Promise {
        element: ExprId,
    },
    Alternatives {
        values: Vec<ExprId>,
    },
    Definition {
        def: i32,
    },
    Module {
        import: usize,
    },
    Object,
    Class,
    This,
    Super,
    Callable,
    Signature {
        construct: bool,
        returns: Option<ExprId>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Encode, Decode)]
#[serde(rename_all = "snake_case")]
pub enum Space {
    Value,
    Type,
    Both,
}

/// A declaration without a graph node still hides outer declarations.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Encode, Decode)]
pub struct LexicalBinding {
    pub name: String,
    pub scope: i32,
    pub def: i32,
    pub space: Space,
    pub value: Option<ExprId>,
    pub parameter: Option<Parameter>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Encode, Decode)]
pub struct Parameter {
    pub position: u32,
    pub rest: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, Encode, Decode)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Owner {
    Definition { def: i32, is_static: bool },
    Object { expression: ExprId },
    ClassExpression { expression: ExprId, is_static: bool },
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Encode, Decode)]
pub struct Member {
    pub owner: Owner,
    pub name: String,
    pub scope: i32,
    pub def: i32,
    pub value: Option<ExprId>,
    pub getter: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Encode, Decode)]
pub struct ThisBinding {
    pub scope: i32,
    pub owner: Owner,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Encode, Decode)]
pub struct Base {
    pub def: i32,
    pub expression: ExprId,
    pub scope: i32,
    /// Refers to the corresponding entry in `Def::heritage`.
    pub heritage: usize,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Encode, Decode)]
pub struct Return {
    pub def: i32,
    pub scope: i32,
    pub value: Option<ExprId>,
    pub declared: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Encode, Decode)]
pub struct TypeAlias {
    pub def: i32,
    pub scope: i32,
    pub value: ExprId,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Encode, Decode)]
pub struct ConstructSignature {
    pub owner: Owner,
    pub scope: i32,
    pub value: Option<ExprId>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Encode, Decode)]
pub struct ImportSite {
    pub import: usize,
    pub binding: usize,
    pub range: Range,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Encode, Decode)]
#[serde(rename_all = "snake_case")]
pub enum ExportKind {
    Default,
    Assignment,
    CommonJs,
    CommonJsAlias,
    DropExportsAlias,
    RestoreExportsAlias,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Encode, Decode)]
pub struct ExportValue {
    /// `None` is `module.exports` or `export =`, otherwise a named export.
    pub name: Option<String>,
    pub scope: i32,
    pub value: Option<ExprId>,
    pub kind: ExportKind,
    pub range: Range,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Encode, Decode)]
pub struct Reference {
    pub expression: ExprId,
    pub caller: i32,
    pub scope: i32,
    pub range: Range,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Encode, Decode)]
pub struct Argument {
    pub call: usize,
    pub position: u32,
    pub expression: ExprId,
    pub range: Range,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Encode, Decode)]
pub struct ParameterCall {
    pub scope: i32,
    pub expression: ExprId,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Encode, Decode)]
pub struct FormalType {
    pub def: i32,
    pub scope: i32,
    pub position: u32,
    pub expression: ExprId,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Encode, Decode)]
pub struct ContextualCall {
    pub call: usize,
    pub types: Vec<Option<ExprId>>,
    pub objects: Vec<(u32, ExprId)>,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize, Encode, Decode)]
pub struct ReferenceFacts {
    pub expressions: Vec<Expression>,
    pub bindings: Vec<LexicalBinding>,
    pub initializer_scopes: Vec<(usize, i32)>,
    pub members: Vec<Member>,
    pub this_bindings: Vec<ThisBinding>,
    pub explicit_this: Vec<(i32, ExprId)>,
    pub bases: Vec<Base>,
    /// A class expression can own graph methods even if it has no graph node.
    pub class_bases: Vec<(ExprId, i32, ExprId)>,
    pub callable_defs: Vec<i32>,
    pub signature_defs: Vec<i32>,
    pub formal_types: Vec<FormalType>,
    pub contextual_calls: Vec<ContextualCall>,
    pub returns: Vec<Return>,
    pub type_aliases: Vec<TypeAlias>,
    pub construct_signatures: Vec<ConstructSignature>,
    pub import_sites: Vec<ImportSite>,
    pub export_values: Vec<ExportValue>,
    pub references: Vec<Reference>,
    pub arguments: Vec<Argument>,
    pub parameter_calls: Vec<ParameterCall>,
}

impl ReferenceFacts {
    pub(super) fn trim_extraction_capacity(&mut self) {
        self.expressions.shrink_to_fit();
        self.bindings.shrink_to_fit();
        self.members.shrink_to_fit();
        self.formal_types.shrink_to_fit();
        self.returns.shrink_to_fit();
        self.references.shrink_to_fit();
        self.arguments.shrink_to_fit();
    }
}
