use mex_graph_core::facts::ecmascript::{
    ExportKind, ExportValue, Expression, ImportSite, Owner, Space,
};
use mex_graph_core::facts::{Export, Import, ImportBinding, ImportForm, NONE};
use tree_sitter::Node;

use super::{Collector, Context, named};
use crate::nodes::syntax::{access, field, first_named, token};

impl<'a> Collector<'a, '_> {
    pub(super) fn add_import(
        &mut self,
        form: ImportForm,
        specifier: String,
        node: Node,
        scope: i32,
    ) -> usize {
        let index = self.facts.imports.len();
        self.facts.imports.push(Import {
            form,
            specifier,
            level: 0,
            bindings: Vec::new(),
            scope,
            range: self.range(node),
        });
        index
    }

    pub(super) fn dynamic_import(&mut self, node: Node, scope: i32) -> Option<usize> {
        let args = field(node, "arguments")?;
        let specifier = self.string(first_named(args)?)?;
        Some(self.add_import(ImportForm::Dynamic, specifier, node, scope))
    }

    pub(super) fn import_statement(&mut self, node: Node<'a>, context: Context) {
        if let Some(clause) = named(node).find(|part| part.kind() == "import_require_clause") {
            if let Some(local) = first_named(clause)
                && let Some(specifier) = field(clause, "source").and_then(|n| self.string(n))
            {
                let import = self.add_import(ImportForm::CommonJs, specifier, node, context.scope);
                self.import_name(import, "*".into(), local, token(node, "type").is_some());
            }
            return;
        }
        let Some(specifier) = field(node, "source").and_then(|n| self.string(n)) else {
            return;
        };
        let type_only = token(node, "type").is_some();
        let form = if type_only {
            self.mode_attribute(node).unwrap_or(ImportForm::Es)
        } else {
            ImportForm::Es
        };
        let import = self.add_import(form, specifier, node, context.scope);
        let Some(clause) = named(node).find(|part| part.kind() == "import_clause") else {
            return;
        };
        for part in named(clause) {
            match part.kind() {
                "identifier" => self.import_name(import, "default".into(), part, type_only),
                "namespace_import" => {
                    if let Some(local) = first_named(part) {
                        self.import_name(import, "*".into(), local, type_only);
                    }
                }
                "named_imports" => {
                    for specifier in named(part) {
                        if let Some(name) = field(specifier, "name") {
                            self.import_name(
                                import,
                                self.name(name),
                                field(specifier, "alias").unwrap_or(name),
                                type_only || token(specifier, "type").is_some(),
                            );
                        }
                    }
                }
                _ => {}
            }
        }
    }

    fn mode_attribute(&self, node: Node) -> Option<ImportForm> {
        let attributes = named(node).find(|part| part.kind() == "import_attribute")?;
        let mut entries = named(first_named(attributes)?);
        let entry = entries.next()?;
        if entries.next().is_some()
            || self.string(field(entry, "key")?)?.as_str() != "resolution-mode"
        {
            return None;
        }
        match self.string(field(entry, "value")?)?.as_str() {
            "import" => Some(ImportForm::TypeWithImportMode),
            "require" => Some(ImportForm::TypeWithRequireMode),
            _ => None,
        }
    }

    fn import_name(&mut self, import: usize, imported: String, local: Node, type_only: bool) {
        let scope = self.facts.imports[import].scope;
        let binding = self.facts.imports[import].bindings.len();
        let name = self.name(local);
        let mut value = self.push_expression(Expression::Module { import });
        if imported != "*" {
            value = value.and_then(|object| {
                self.push_expression(Expression::Member {
                    object,
                    name: imported.clone(),
                })
            });
        }
        self.add_binding(
            name.clone(),
            scope,
            NONE,
            if type_only { Space::Type } else { Space::Both },
            value,
            true,
        );
        self.facts.imports[import].bindings.push(ImportBinding {
            imported,
            local: Some(name),
            exported: None,
            type_only,
        });
        self.extra.import_sites.push(ImportSite {
            import,
            binding,
            range: self.range(local),
        });
    }

    pub(super) fn export_statement(&mut self, node: Node<'a>, context: Context) {
        if context.scope != NONE {
            return;
        }
        let range = self.range(node);
        let type_only = token(node, "type").is_some();
        let specifier = field(node, "source").and_then(|n| self.string(n));
        let mut bindings = Vec::new();
        for part in named(node) {
            match part.kind() {
                "export_clause" => {
                    for item in named(part) {
                        let Some(name) = field(item, "name") else {
                            continue;
                        };
                        let exported = self.name(field(item, "alias").unwrap_or(name));
                        let name = self.name(name);
                        let type_only = type_only || token(item, "type").is_some();
                        if specifier.is_some() {
                            bindings.push(ImportBinding {
                                imported: name,
                                local: None,
                                exported: Some(exported),
                                type_only,
                            });
                        } else {
                            self.facts.exports.push(Export {
                                local: Some(name),
                                def: NONE,
                                exported,
                                type_only,
                                range,
                            });
                        }
                    }
                }
                "namespace_export" => {
                    if let Some(alias) = first_named(part) {
                        bindings.push(ImportBinding {
                            imported: "*".into(),
                            local: None,
                            exported: Some(self.name(alias)),
                            type_only,
                        });
                    }
                }
                _ => {}
            }
        }
        if let Some(specifier) = specifier {
            if bindings.is_empty() && token(node, "*").is_some() {
                bindings.push(ImportBinding {
                    imported: "*".into(),
                    local: None,
                    exported: Some("*".into()),
                    type_only,
                });
            }
            let import = self.add_import(ImportForm::Reexport, specifier, node, context.scope);
            self.facts.imports[import].bindings = bindings;
        } else if let Some(value) = field(node, "value") {
            if token(node, "default").is_some() {
                let def = self.draft(value);
                let local = (value.kind() == "identifier").then(|| self.name(value));
                if def != NONE || local.is_some() {
                    self.facts.exports.push(Export {
                        local,
                        def,
                        exported: "default".into(),
                        type_only: false,
                        range,
                    });
                } else {
                    let expression = self.expression(value, context);
                    self.extra.export_values.push(ExportValue {
                        name: Some("default".into()),
                        scope: context.scope,
                        value: expression,
                        kind: ExportKind::Default,
                        range,
                    });
                }
            } else if token(node, "=").is_some() {
                let expression = self.expression(value, context);
                self.extra.export_values.push(ExportValue {
                    name: None,
                    scope: context.scope,
                    value: expression,
                    kind: ExportKind::Assignment,
                    range,
                });
            }
        } else if token(node, "=").is_some()
            && let Some(value) = first_named(node)
        {
            let expression = self.expression(value, context);
            self.extra.export_values.push(ExportValue {
                name: None,
                scope: context.scope,
                value: expression,
                kind: ExportKind::Assignment,
                range,
            });
        }
    }

    pub(super) fn named_export(
        &mut self,
        node: Node,
        context: Context,
        name: &str,
        def: i32,
        type_only: bool,
    ) {
        if !self.direct_export(node) {
            return;
        }
        let range = self.range(node);
        if context.scope == NONE {
            let default = self
                .source
                .parent(node)
                .is_some_and(|parent| token(parent, "default").is_some());
            self.facts.exports.push(Export {
                local: Some(name.to_owned()),
                def,
                exported: if default {
                    "default".into()
                } else {
                    name.into()
                },
                type_only,
                range,
            });
        } else if context.namespace != NONE {
            let owner = Owner::Definition {
                def: context.namespace,
                is_static: true,
            };
            let value = self.push_expression(Expression::Name { name: name.into() });
            self.add_member(owner, name.into(), context.scope, def, value, false);
        }
    }

    fn direct_export(&self, node: Node<'a>) -> bool {
        let original = node;
        let mut node = node;
        while let Some(parent) = self.source.parent(node) {
            match parent.kind() {
                "lexical_declaration" | "variable_declaration" | "ambient_declaration" => {
                    node = parent
                }
                "export_statement" => return field(parent, "value") != Some(original),
                _ => break,
            }
        }
        false
    }

    pub(super) fn commonjs_export(
        &mut self,
        node: Node<'a>,
        context: Context,
        left: Node<'a>,
        right: Node<'a>,
    ) -> bool {
        // A conditional or deferred assignment is insufficient module evidence.
        if context.scope != NONE
            || !self
                .source
                .parent(node)
                .is_some_and(|p| p.kind() == "expression_statement")
        {
            return false;
        }
        if left.kind() == "identifier" && self.name(left) == "exports" {
            let kind = if self.is_module_exports(right) {
                ExportKind::RestoreExportsAlias
            } else {
                ExportKind::DropExportsAlias
            };
            self.extra.export_values.push(ExportValue {
                name: None,
                scope: context.scope,
                value: None,
                kind,
                range: self.range(node),
            });
            return true;
        }
        let Some((object, property)) = access(left) else {
            return false;
        };
        if !static_access(left, property) {
            return false;
        }
        let via_exports_alias = object.kind() == "identifier" && self.name(object) == "exports";
        let property = self.name(property);
        let name = if object.kind() == "identifier"
            && self.name(object) == "module"
            && property == "exports"
        {
            None
        } else if via_exports_alias || self.is_module_exports(object) {
            Some(property)
        } else {
            return false;
        };
        let def = self.draft(node);
        let value = if def != NONE {
            self.push_expression(Expression::Definition { def })
        } else {
            self.expression(right, context)
        };
        self.extra.export_values.push(ExportValue {
            name,
            scope: context.scope,
            value,
            kind: if via_exports_alias {
                ExportKind::CommonJsAlias
            } else {
                ExportKind::CommonJs
            },
            range: self.range(node),
        });
        true
    }

    pub(super) fn is_module_exports(&self, node: Node) -> bool {
        access(node).is_some_and(|(object, property)| {
            static_access(node, property)
                && object.kind() == "identifier"
                && self.name(object) == "module"
                && self.name(property) == "exports"
        })
    }
}

pub(super) fn static_access(node: Node, property: Node) -> bool {
    node.kind() == "member_expression"
        || super::super::syntax::is_string_literal(property)
        || property.kind() == "number"
}
