//! Native C# declarations and references. The grammar is the same 0.23.5
//! release as the vendored WASM parser.

use mex_graph_core::facts::{Def, FileFacts, Import, ImportForm, Kind, ReferenceKind};
use mex_graph_syntax::{Declarations, Extractor, Text, children, empty_def, named_children};
use tree_sitter::Node;

pub mod resolve;

pub const LANGUAGE: &str = "csharp";
pub const ADAPTER_VERSION: u32 = 1;

pub struct CSharp(Extractor);

impl Default for CSharp {
    fn default() -> Self {
        Self::new()
    }
}

impl CSharp {
    pub fn new() -> Self {
        Self(Extractor::new(
            LANGUAGE,
            ".",
            tree_sitter_c_sharp::LANGUAGE.into(),
        ))
    }

    pub fn extract(&mut self, path: &str, source: &str, hash: [u8; 32]) -> FileFacts {
        self.0.extract(path, source, hash, |root, declarations| {
            Walker(declarations).run(root);
        })
    }
}

struct Walker<'walker, 'source>(&'walker mut Declarations<'source>);

impl Walker<'_, '_> {
    fn run(&mut self, root: Node) {
        for child in named_children(root) {
            self.visit(child);
            // The file-scoped namespace owns every subsequent root sibling.
            if child.kind() == "file_scoped_namespace_declaration" {
                break;
            }
        }
    }

    fn visit(&mut self, node: Node) {
        let kind = node.kind();
        match kind {
            "namespace_declaration" | "file_scoped_namespace_declaration" => self.namespace(node),
            "enum_declaration" => self.enum_item(node),
            "delegate_declaration" => self.delegate(node),
            "local_function_statement" => self.method(node, Kind::Function),
            "property_declaration" | "indexer_declaration" | "event_declaration" => {
                self.property(node)
            }
            "field_declaration" | "event_field_declaration" => self.fields(node),
            "using_directive" => self.using_directive(node),
            kind if is_method(kind) => self.method(node, Kind::Method),
            kind if type_kind(kind).is_some() => {
                self.type_declaration(node, type_kind(kind).unwrap());
            }
            _ => self.visit_children(node),
        }
    }

    fn visit_children(&mut self, node: Node) {
        for child in named_children(node) {
            self.visit(child);
        }
    }

    fn namespace(&mut self, node: Node) {
        let text = &self.0.text;
        let Some(name) = node.child_by_field_name("name") else {
            return;
        };
        let Some(id) = self.0.create(
            Kind::Namespace,
            text.of(name),
            node,
            empty_def(text.range(name)),
        ) else {
            return;
        };
        self.0.stack.push(id);
        if let Some(body) = node.child_by_field_name("body") {
            self.visit_children(body);
        } else {
            let mut next = node.next_named_sibling();
            while let Some(sibling) = next {
                self.visit(sibling);
                next = sibling.next_named_sibling();
            }
        }
        self.0.stack.pop();
    }

    fn type_declaration(&mut self, node: Node, kind: Kind) {
        let text = &self.0.text;
        let Some(name) = node.child_by_field_name("name") else {
            return;
        };
        let mut def = with_modifiers(text, node, name);
        flags(&mut def, &modifiers(text, node), &["abstract", "static"]);
        let Some(id) = self.0.create(kind, text.of(name), node, def) else {
            return;
        };
        self.heritage(node, id, kind == Kind::Interface);
        self.attributes(node, id);
        if let Some(body) = node.child_by_field_name("body") {
            self.0.stack.push(id);
            self.visit_children(body);
            self.0.stack.pop();
        }
    }

    fn enum_item(&mut self, node: Node) {
        let text = &self.0.text;
        let Some(name) = node.child_by_field_name("name") else {
            return;
        };
        let def = with_modifiers(text, node, name);
        let Some(id) = self.0.create(Kind::Enum, text.of(name), node, def) else {
            return;
        };
        let Some(body) = node.child_by_field_name("body") else {
            return;
        };
        self.0.stack.push(id);
        for member in named_children(body)
            .into_iter()
            .filter(|n| n.kind() == "enum_member_declaration")
        {
            if let Some(name) = member.child_by_field_name("name") {
                let text = &self.0.text;
                self.0.create(
                    Kind::EnumMember,
                    text.of(name),
                    member,
                    empty_def(text.range(name)),
                );
            }
        }
        self.0.stack.pop();
    }

    fn delegate(&mut self, node: Node) {
        let text = &self.0.text;
        let Some(name) = node.child_by_field_name("name") else {
            return;
        };
        let mut def = with_modifiers(text, node, name);
        def.return_type = field_text(text, node, "type").map(str::to_owned);
        def.signature = text.field(node, "parameters").into();
        self.0.create(Kind::TypeAlias, text.of(name), node, def);
    }

    fn method(&mut self, node: Node, kind: Kind) {
        let text = &self.0.text;
        let name = method_name(text, node);
        let mut def = with_modifiers(text, node, node.child_by_field_name("name").unwrap_or(node));
        flags(
            &mut def,
            &modifiers(text, node),
            &["static", "abstract", "async"],
        );
        def.return_type = field_text(text, node, "returns")
            .or_else(|| field_text(text, node, "type"))
            .map(str::to_owned);
        def.signature = text.field(node, "parameters").into();
        let Some(id) = self.0.create(kind, &name, node, def) else {
            return;
        };
        self.attributes(node, id);
        self.parameters(node, id);
        if let Some(body) = node
            .child_by_field_name("body")
            .or_else(|| node.child_by_field_name("value"))
        {
            self.body(body, id);
        }
    }

    fn property(&mut self, node: Node) {
        let text = &self.0.text;
        let name = if node.kind() == "indexer_declaration" {
            "this"
        } else {
            text.field(node, "name")
        };
        let mut def = with_modifiers(text, node, node.child_by_field_name("name").unwrap_or(node));
        flags(&mut def, &modifiers(text, node), &["static"]);
        def.return_type = field_text(text, node, "type").map(str::to_owned);
        def.signature = text.field(node, "parameters").into();
        let Some(id) = self.0.create(Kind::Property, name, node, def) else {
            return;
        };
        self.attributes(node, id);
        self.parameters(node, id);
        for field in ["value", "accessors"] {
            if let Some(body) = node.child_by_field_name(field) {
                self.body(body, id);
            }
        }
    }

    fn fields(&mut self, node: Node) {
        // Fields can have multiple declarators, each owning its initializer.
        let Some(vars) = named_children(node)
            .into_iter()
            .find(|n| n.kind() == "variable_declaration")
        else {
            return;
        };
        let modifiers = modifiers(&self.0.text, node);
        let is_const = modifiers.contains(&"const");
        let kind = if is_const {
            Kind::Constant
        } else {
            Kind::Field
        };
        for var in named_children(vars)
            .into_iter()
            .filter(|n| n.kind() == "variable_declarator")
        {
            let Some(name) = var.child_by_field_name("name") else {
                continue;
            };
            let text = &self.0.text;
            let mut def = with_modifiers(text, node, name);
            if is_const || modifiers.contains(&"static") {
                def.flags.push("static".into());
            }
            def.return_type = field_text(text, vars, "type").map(str::to_owned);
            if let Some(id) = self.0.create(kind, text.of(name), var, def) {
                self.attributes(node, id);
                self.body(var, id);
            }
        }
    }

    fn using_directive(&mut self, node: Node) {
        let text = &self.0.text;
        let Some(name) = node
            .child_by_field_name("name")
            .or_else(|| node.named_child(0))
        else {
            return;
        };
        if text.of(name).is_empty() {
            return;
        }
        self.0.add_import(Import {
            form: ImportForm::CSharpUsing,
            specifier: text.of(name).into(),
            level: 0,
            scope: 0,
            range: text.range(node),
            bindings: Vec::new(),
        });
    }

    fn heritage(&mut self, node: Node, owner: usize, interface: bool) {
        let Some(base) = named_children(node)
            .into_iter()
            .find(|n| n.kind() == "base_list")
        else {
            return;
        };
        let entries = named_children(base).into_iter().filter(|n| {
            matches!(
                n.kind(),
                "type"
                    | "identifier"
                    | "generic_name"
                    | "qualified_name"
                    | "primary_constructor_base_type"
            )
        });
        for (index, entry) in entries.enumerate() {
            // Syntax gives no base-class vs. interface distinction.
            let kind = if interface || index == 0 {
                ReferenceKind::Extends
            } else {
                ReferenceKind::Implements
            };
            self.0
                .add_reference(owner, kind, self.0.text.of(entry), entry);
        }
    }

    fn attributes(&mut self, node: Node, owner: usize) {
        for list in named_children(node)
            .into_iter()
            .filter(|n| n.kind() == "attribute_list")
        {
            for attribute in named_children(list)
                .into_iter()
                .filter(|n| n.kind() == "attribute")
            {
                self.0.add_reference(
                    owner,
                    ReferenceKind::Decorates,
                    self.0.text.field(attribute, "name"),
                    attribute,
                );
            }
        }
    }

    fn parameters(&mut self, node: Node, owner: usize) {
        let Some(params) = node.child_by_field_name("parameters") else {
            return;
        };
        self.0.stack.push(owner);
        for param in named_children(params)
            .into_iter()
            .filter(|n| n.kind() == "parameter")
        {
            let Some(name) = param.child_by_field_name("name") else {
                continue;
            };
            let text = &self.0.text;
            let mut def = empty_def(text.range(name));
            def.return_type = field_text(text, param, "type").map(str::to_owned);
            self.0.create(Kind::Parameter, text.of(name), param, def);
        }
        self.0.stack.pop();
    }

    fn body(&mut self, node: Node, owner: usize) {
        match node.kind() {
            "invocation_expression" => self.call(node, owner),
            "object_creation_expression" | "implicit_object_creation_expression" => {
                self.0.add_reference(
                    owner,
                    ReferenceKind::Instantiates,
                    self.0.text.field(node, "type"),
                    node,
                );
            }
            kind if is_method(kind)
                || kind == "local_function_statement"
                || type_kind(kind).is_some() =>
            {
                self.0.stack.push(owner);
                self.visit(node);
                self.0.stack.pop();
                return;
            }
            _ => {}
        }
        for child in named_children(node) {
            self.body(child, owner);
        }
    }

    fn call(&mut self, node: Node, owner: usize) {
        let Some(function) = node.child_by_field_name("function") else {
            return;
        };
        let text = &self.0.text;
        if function.kind() == "member_access_expression" {
            let receiver = function.child_by_field_name("expression").or_else(|| {
                children(function)
                    .into_iter()
                    .find(|n| matches!(n.kind(), "this" | "base"))
            });
            if let (Some(receiver), Some(name)) = (receiver, function.child_by_field_name("name")) {
                self.0.add_reference(
                    owner,
                    ReferenceKind::Calls,
                    &format!("{}.{}", text.of(receiver), text.of(name)),
                    node,
                );
                return;
            }
        }
        self.0
            .add_reference(owner, ReferenceKind::Calls, text.of(function), node);
    }
}

fn type_kind(kind: &str) -> Option<Kind> {
    match kind {
        "class_declaration" | "record_declaration" => Some(Kind::Class),
        "struct_declaration" => Some(Kind::Struct),
        "interface_declaration" => Some(Kind::Interface),
        _ => None,
    }
}

fn is_method(kind: &str) -> bool {
    matches!(
        kind,
        "method_declaration"
            | "constructor_declaration"
            | "destructor_declaration"
            | "operator_declaration"
            | "conversion_operator_declaration"
    )
}

fn field_text<'a>(text: &Text<'a>, node: Node, field: &str) -> Option<&'a str> {
    node.child_by_field_name(field).map(|child| text.of(child))
}

fn modifiers<'a>(text: &Text<'a>, declaration: Node) -> Vec<&'a str> {
    named_children(declaration)
        .into_iter()
        .filter(|n| n.kind() == "modifier")
        .map(|n| text.of(n))
        .collect()
}

fn with_modifiers(text: &Text<'_>, declaration: Node, name: Node) -> Def {
    let modifiers = modifiers(text, declaration);
    let mut def = empty_def(text.range(name));
    def.visibility = modifiers
        .iter()
        .find(|&&m| matches!(m, "public" | "private" | "protected" | "internal"))
        .map(|&m| m.into());
    def.exported = modifiers.contains(&"public");
    def
}

fn flags(def: &mut Def, modifiers: &[&str], flags: &[&str]) {
    def.flags.extend(
        flags
            .iter()
            .filter(|flag| modifiers.contains(flag))
            .map(|&flag| flag.into()),
    );
}

fn method_name(text: &Text<'_>, node: Node) -> String {
    let kind = node.kind();
    if matches!(
        kind,
        "operator_declaration" | "conversion_operator_declaration"
    ) {
        let children = children(node);
        let checked = if children.iter().any(|n| n.kind() == "checked") {
            "checked "
        } else {
            ""
        };
        if kind == "operator_declaration" {
            return field_text(text, node, "operator")
                .map_or_else(String::new, |op| format!("operator {checked}{op}"));
        }
        let conversion = children
            .iter()
            .find(|n| matches!(n.kind(), "implicit" | "explicit"));
        return conversion
            .zip(field_text(text, node, "type"))
            .map_or_else(String::new, |(conversion, ty)| {
                format!("{} operator {checked}{ty}", text.of(*conversion))
            });
    }

    let name = field_text(text, node, "name").or_else(|| {
        if !matches!(kind, "constructor_declaration" | "destructor_declaration") {
            return None;
        }
        let mut enclosing = node.parent();
        while let Some(parent) = enclosing {
            if type_kind(parent.kind()).is_some() {
                return field_text(text, parent, "name");
            }
            enclosing = parent.parent();
        }
        None
    });
    let Some(name) = name.filter(|name| !name.is_empty()) else {
        return String::new();
    };
    match kind {
        "destructor_declaration" => format!("~{name}"),
        "constructor_declaration" if modifiers(text, node).contains(&"static") => {
            format!("static {name}")
        }
        _ => name.into(),
    }
}
