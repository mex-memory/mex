//! Native Rust declarations and references, using the grammar in the WASM route.

use mex_graph_core::facts::{
    Def, FileFacts, Import, ImportBinding, ImportForm, Kind, ReferenceKind,
};
use mex_graph_core::text::js_trim;
use mex_graph_syntax::{Declarations, Extractor, Text, children, empty_def, named_children};
use tree_sitter::Node;

mod grammar;
pub mod resolve;

pub const LANGUAGE: &str = "rust";
pub const ADAPTER_VERSION: u32 = 1;

pub struct Rust(Extractor);

impl Default for Rust {
    fn default() -> Self {
        Self::new()
    }
}

impl Rust {
    pub fn new() -> Self {
        Self(Extractor::new(LANGUAGE, "::", grammar::LANGUAGE.into()))
    }

    pub fn extract(&mut self, path: &str, source: &str, hash: [u8; 32]) -> FileFacts {
        self.0.extract(path, source, hash, |root, declarations| {
            Walker {
                declarations,
                impls: Vec::new(),
            }
            .run(root);
        })
    }
}

struct Walker<'tree, 'source, 'walker> {
    declarations: &'walker mut Declarations<'source>,
    impls: Vec<(Node<'tree>, Vec<usize>)>,
}

impl<'tree> Walker<'tree, '_, '_> {
    fn run(&mut self, root: Node<'tree>) {
        for child in named_children(root) {
            self.visit(child);
        }
        // Keep the same declaration order and owners for impls before a type.
        let mut index = 0;
        while let Some((node, stack)) = self.impls.get_mut(index) {
            let node = *node;
            self.declarations.stack = std::mem::take(stack);
            self.implementation(node);
            index += 1;
        }
    }

    fn visit(&mut self, node: Node<'tree>) {
        match node.kind() {
            "function_item" | "function_signature_item" => self.function(node, Kind::Function),
            "struct_item" | "enum_item" => self.class_or_enum(node),
            "trait_item" => self.trait_item(node),
            "impl_item" => self.impls.push((node, self.declarations.stack.clone())),
            "mod_item" => self.module(node),
            "const_item" => {
                self.named(Kind::Constant, node);
            }
            "static_item" => {
                self.named(Kind::Variable, node);
            }
            "use_declaration" => self.use_item(node),
            "macro_invocation" => {
                if let Some(tree) = named_children(node)
                    .into_iter()
                    .find(|n| n.kind() == "token_tree")
                {
                    self.visit_children(tree);
                }
            }
            _ => self.visit_children(node),
        }
    }

    fn visit_children(&mut self, node: Node<'tree>) {
        for child in named_children(node) {
            self.visit(child);
        }
    }

    fn declare(&mut self, kind: Kind, name: &str, node: Node, mut def: Def) -> Option<usize> {
        let text = &self.declarations.text;
        def.exported = children(node)
            .into_iter()
            .any(|n| n.kind() == "visibility_modifier" && text.of(n).contains("pub"));
        def.visibility = def.exported.then(|| "public".into());
        let mut docs = Vec::new();
        let mut preceding = node.prev_named_sibling();
        while let Some(comment) =
            preceding.filter(|n| matches!(n.kind(), "line_comment" | "block_comment"))
        {
            let value = js_trim(text.of(comment));
            if value.starts_with("///") || value.starts_with("//!") {
                docs.push(value);
            }
            preceding = comment.prev_named_sibling();
        }
        if !docs.is_empty() {
            docs.reverse();
            def.docstring = Some(docs.join("\n"));
        }
        self.declarations.create(kind, name, node, def)
    }

    fn named(&mut self, kind: Kind, node: Node) -> Option<usize> {
        let name = node.child_by_field_name("name")?;
        let text = &self.declarations.text;
        self.declare(kind, text.of(name), node, empty_def(text.range(name)))
    }

    fn function(&mut self, node: Node, kind: Kind) {
        let Some(name) = node.child_by_field_name("name") else {
            return;
        };
        let text = &self.declarations.text;
        let mut def = empty_def(text.range(name));
        let return_type = node.child_by_field_name("return_type");
        if let Some(params) = node.child_by_field_name("parameters") {
            def.signature = text.of(params).to_owned();
            if let Some(ret) = return_type {
                def.signature.push(' ');
                def.signature.push_str(text.of(ret));
            }
        }
        def.return_type = return_type.map(|ret| {
            let value = text.of(ret);
            value.strip_prefix("->").map_or(value, js_trim).into()
        });
        def.type_parameters = type_parameters(text, node);
        let Some(id) = self.declare(kind, text.of(name), node, def) else {
            return;
        };
        if let Some(ret) = return_type {
            self.add_type_reference(id, ReferenceKind::Returns, ret, ret);
        }
        if let Some(body) = node.child_by_field_name("body") {
            self.body(body, id);
        }
    }

    fn type_declaration(&mut self, kind: Kind, node: Node) -> Option<usize> {
        let name = node.child_by_field_name("name")?;
        let text = &self.declarations.text;
        let mut def = empty_def(text.range(name));
        def.type_parameters = type_parameters(text, node);
        self.declare(kind, text.of(name), node, def)
    }

    fn class_or_enum(&mut self, node: Node) {
        let kind = if node.kind() == "struct_item" {
            Kind::Class
        } else {
            Kind::Enum
        };
        let Some(id) = self.type_declaration(kind, node) else {
            return;
        };
        let body = node.child_by_field_name("body").or_else(|| {
            named_children(node)
                .into_iter()
                .find(|n| matches!(n.kind(), "field_declaration_list" | "enum_variant_list"))
        });
        let Some(body) = body else { return };
        self.declarations.stack.push(id);
        for member in named_children(body) {
            match member.kind() {
                "enum_variant" => {
                    let name = member.child_by_field_name("name").unwrap_or(member);
                    let text = &self.declarations.text;
                    self.declare(
                        Kind::EnumMember,
                        text.of(name),
                        member,
                        empty_def(text.range(name)),
                    );
                }
                "field_declaration" => {
                    let field = self.named(Kind::Property, member);
                    if let (Some(field), Some(ty)) = (field, member.child_by_field_name("type")) {
                        self.add_type_reference(field, ReferenceKind::TypeOf, ty, member);
                    }
                }
                _ => {}
            }
        }
        self.declarations.stack.pop();
    }

    fn trait_item(&mut self, node: Node<'tree>) {
        if let Some(id) = self.type_declaration(Kind::Interface, node) {
            self.members(node, id, false);
        }
    }

    fn implementation(&mut self, node: Node<'tree>) {
        let Some(ty) = node.child_by_field_name("type").and_then(base_type) else {
            return;
        };
        let text = &self.declarations.text;
        let name = text.of(ty);
        // The existing signature id profile uses this same-file impl owner.
        let owner = self.declarations.defs.iter().position(|d| {
            d.name == name && matches!(d.kind, Kind::Class | Kind::Enum | Kind::Interface)
        });
        let Some(id) = owner.or_else(|| {
            self.declare(
                Kind::Namespace,
                name,
                node,
                empty_def(self.declarations.text.range(ty)),
            )
        }) else {
            return;
        };
        if let Some(trait_type) = node.child_by_field_name("trait") {
            self.add_type_reference(id, ReferenceKind::Implements, trait_type, node);
        }
        self.members(node, id, true);
    }

    fn members(&mut self, node: Node<'tree>, id: usize, walk_others: bool) {
        let Some(body) = node.child_by_field_name("body") else {
            return;
        };
        self.declarations.stack.push(id);
        for member in named_children(body) {
            if matches!(member.kind(), "function_item" | "function_signature_item") {
                self.function(member, Kind::Method);
            } else if walk_others {
                self.visit(member);
            }
        }
        self.declarations.stack.pop();
    }

    fn module(&mut self, node: Node<'tree>) {
        let Some(id) = self.named(Kind::Namespace, node) else {
            return;
        };
        self.declarations.defs[id].flags.push("rust_module".into());
        if let Some(body) = node.child_by_field_name("body") {
            self.declarations.stack.push(id);
            self.visit_children(body);
            self.declarations.stack.pop();
        } else {
            self.declarations.defs[id]
                .flags
                .push("rust_external_module".into());
        }
    }

    fn use_item(&mut self, node: Node) {
        let Some(arg) = node.child_by_field_name("argument") else {
            return;
        };
        let text = &self.declarations.text;
        let range = text.range(node);
        let public = children(node)
            .iter()
            .any(|child| child.kind() == "visibility_modifier");
        let scope = self.declarations.stack.last().copied().unwrap_or(0) as i32;
        for (specifier, imported, local) in use_bindings(text, arg, "") {
            self.declarations.add_import(Import {
                form: ImportForm::RustUse,
                specifier,
                level: 0,
                scope,
                range,
                bindings: vec![ImportBinding {
                    imported,
                    exported: public.then(|| local.clone()),
                    local: Some(local),
                    type_only: false,
                }],
            });
        }
    }

    fn body(&mut self, node: Node, owner: usize) {
        match node.kind() {
            "call_expression" => self.call(node, owner),
            "struct_expression" => {
                if let Some(name) = node
                    .child_by_field_name("name")
                    .or_else(|| node.named_child(0))
                {
                    self.add_type_reference(owner, ReferenceKind::Instantiates, name, node);
                }
            }
            "function_item" | "function_signature_item" | "struct_item" | "enum_item" => {
                self.declarations.stack.push(owner);
                if matches!(node.kind(), "function_item" | "function_signature_item") {
                    self.function(node, Kind::Function);
                } else {
                    self.class_or_enum(node);
                }
                self.declarations.stack.pop();
                return;
            }
            _ => {}
        }
        for child in named_children(node) {
            self.body(child, owner);
        }
    }

    fn call(&mut self, node: Node, owner: usize) {
        let Some(function) = node
            .child_by_field_name("function")
            .or_else(|| node.named_child(0))
        else {
            return;
        };
        let text = &self.declarations.text;
        if function.kind() == "field_expression" {
            let Some(value) = function.child_by_field_name("value") else {
                return;
            };
            let receiver = js_trim(text.of(value));
            let member = text.field(function, "field");
            if !receiver.is_empty() && !member.is_empty() {
                let call = (value.kind() == "call_expression")
                    .then(|| value.child_by_field_name("function"))
                    .flatten()
                    .map(|callee| path_text(text, callee));
                self.declarations.add_reference_with_receiver(
                    owner,
                    ReferenceKind::Calls,
                    &format!("{receiver}.{member}"),
                    node,
                    call,
                );
            }
        } else {
            let callee = path_text(text, function);
            self.declarations
                .add_reference(owner, ReferenceKind::Calls, &callee, node);
        }
    }

    fn add_type_reference(&mut self, id: usize, kind: ReferenceKind, ty: Node, site: Node) {
        if let Some(ty) = base_type(ty) {
            self.declarations
                .add_reference(id, kind, self.declarations.text.of(ty), site);
        }
    }
}

fn base_type(node: Node) -> Option<Node> {
    match node.kind() {
        "generic_type" | "generic_type_with_turbofish" => node.named_child(0).and_then(base_type),
        "reference_type" | "pointer_type" => named_children(node)
            .into_iter()
            .rev()
            .find(|n| !matches!(n.kind(), "lifetime" | "mutable_specifier"))
            .and_then(base_type),
        _ => Some(node),
    }
}

fn type_parameters(text: &Text<'_>, node: Node) -> Vec<String> {
    fn is_name(node: Node) -> bool {
        matches!(node.kind(), "type_identifier" | "identifier" | "lifetime")
    }

    node.child_by_field_name("type_parameters")
        .map(named_children)
        .into_iter()
        .flatten()
        .map(|param| {
            let name = if is_name(param) {
                param
            } else {
                named_children(param)
                    .into_iter()
                    .find(|&n| is_name(n))
                    .unwrap_or(param)
            };
            text.of(name).to_owned()
        })
        .collect()
}

fn use_bindings(text: &Text<'_>, node: Node, prefix: &str) -> Vec<(String, String, String)> {
    let path = |name: &str| {
        if prefix.is_empty() {
            name.to_owned()
        } else if name == "self" {
            prefix.to_owned()
        } else {
            format!("{prefix}::{name}")
        }
    };
    match node.kind() {
        "scoped_use_list" => {
            let prefix = path(text.field(node, "path"));
            node.child_by_field_name("list")
                .map_or_else(Vec::new, |list| use_bindings(text, list, &prefix))
        }
        "use_list" => named_children(node)
            .into_iter()
            .filter(|child| !matches!(child.kind(), "line_comment" | "block_comment"))
            .flat_map(|child| use_bindings(text, child, prefix))
            .collect(),
        "use_as_clause" => {
            let Some(name) = node.child_by_field_name("path") else {
                return Vec::new();
            };
            let specifier = path(&path_text(text, name));
            let imported = specifier.rsplit("::").next().unwrap_or_default().to_owned();
            vec![(specifier, imported, text.field(node, "alias").into())]
        }
        "use_wildcard" => {
            let written = node.named_child(0).map_or_else(
                || "*".into(),
                |base| format!("{}::*", path_text(text, base)),
            );
            vec![(path(&written), "*".into(), "*".into())]
        }
        _ => {
            let specifier = path(&path_text(text, node));
            let name = specifier.rsplit("::").next().unwrap_or_default().to_owned();
            vec![(specifier, name.clone(), name)]
        }
    }
}

fn path_text(text: &Text<'_>, node: Node) -> String {
    if node.kind() == "scoped_identifier"
        && let Some(name) = node.child_by_field_name("name")
    {
        let head = node
            .child_by_field_name("path")
            .map_or_else(String::new, |path| path_text(text, path));
        format!("{head}::{}", text.of(name))
    } else {
        text.of(node).into()
    }
}
