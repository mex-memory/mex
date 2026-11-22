//! Choose one graph draft per bound symbol, then write its evidence.

use std::collections::{HashMap, HashSet};

use mex_graph_core::facts::{
    Def, Diagnostic, Health, Kind, NONE, ParseStatus, Range, SketchFacts, bounds,
};
use mex_graph_core::fingerprint::{SketchBuilder, body_hash};

use super::super::documentation::{annotated_return, documentation, parameter_properties};
use super::super::syntax::{self, field, first_named, has_modifier, initializer, is_function_like};
use super::{Binder, Declaration, Descriptor, ExportModifier, Form, Source, Span};
use crate::scanner::append_token_names;

pub(super) struct Materializer<'a> {
    source: &'a Source<'a>,
    sketches: &'a mut SketchBuilder,
    jsx: bool,
    javascript: bool,
    tokens: Vec<&'static str>,
    bodies: HashMap<(u32, u32), [u8; 32]>,
}

impl<'a> Materializer<'a> {
    pub fn new(
        source: &'a Source<'a>,
        sketches: &'a mut SketchBuilder,
        jsx: bool,
        javascript: bool,
    ) -> Self {
        Self {
            source,
            sketches,
            jsx,
            javascript,
            tokens: Vec::new(),
            bodies: HashMap::new(),
        }
    }

    pub fn finish(
        &mut self,
        path: &str,
        declarations: &[Declaration<'_>],
        binder: &Binder<'_>,
        health: &mut Health,
    ) -> Vec<Def> {
        let file_range = self.source.range(Span {
            start: self.source.start,
            end: self.source.text.len(),
        });
        let mut defs = vec![Def {
            kind: Kind::File,
            name: path.rsplit(['/', '\\']).next().unwrap_or(path).into(),
            qualified_name: path.into(),
            declaration_role: Some("source-file".into()),
            signature: String::new(),
            ordinal: None,
            parent: NONE,
            scope: NONE,
            range: file_range,
            name_range: file_range,
            exported: false,
            is_default_export: false,
            flags: Vec::new(),
            visibility: None,
            decorators: Vec::new(),
            type_parameters: Vec::new(),
            heritage: Vec::new(),
            return_type: None,
            body_hash: None,
            sketch: None,
            docstring: None,
        }];
        let mut owner_by_declaration = vec![None; declarations.len()];
        let mut draft_by_symbol = HashMap::new();
        let mut excluded = HashSet::new();
        let mut compatible = Vec::new();
        for (i, entry) in declarations.iter().enumerate() {
            let parent = entry
                .owner
                .and_then(|owner| owner_by_declaration[owner])
                .unwrap_or(0);
            owner_by_declaration[i].get_or_insert(parent);
            let Some(descriptor) = &entry.descriptor else {
                continue;
            };
            if entry.form != Form::Assignment
                && let Some(draft) = entry.symbol.and_then(|symbol| draft_by_symbol.get(&symbol))
            {
                owner_by_declaration[i] = Some(*draft);
                continue;
            }

            let symbol = entry.symbol.map(|symbol| &binder.symbols[symbol]);
            let group = entry
                .symbol
                .filter(|_| entry.form != Form::Assignment)
                .map(|id| (id, descriptor.kind));
            if group.is_some_and(|key| excluded.contains(&key)) {
                continue;
            }
            compatible.clear();
            if entry.form != Form::Assignment
                && let Some(symbol) = symbol
            {
                compatible.extend(
                    symbol
                        .declarations
                        .iter()
                        .copied()
                        .filter(|&i| declarations[i].form.compatible(descriptor.kind)),
                );
            }
            if compatible.is_empty() {
                compatible.push(i);
            }
            if compatible
                .iter()
                .any(|&i| self.source.has_error(declarations[i].span))
            {
                if let Some(group) = group
                    && (compatible.len() > 1 || compatible[0] != i)
                {
                    excluded.insert(group);
                }
                continue;
            }
            if defs.len() == bounds::MAX_DEFS {
                definition_limit(health, self.source.range(entry.span));
                break;
            }

            let index = defs.len();
            owner_by_declaration[i] = Some(index);
            for &member in &compatible {
                owner_by_declaration[member] = Some(index);
            }
            if let Some(symbol) = entry.symbol {
                draft_by_symbol.insert(symbol, index);
            }
            let representative = implementation(declarations, &compatible);
            compatible.sort_by_key(|&i| declarations[i].span.start);
            let set = compatible
                .iter()
                .map(|&i| declarations.get(i).expect("bound declaration"));
            let docs = documentation(self.source, declarations, symbol, representative);
            let exported = representative.form != Form::Variable
                && representative.modifier.is_export()
                || symbol.is_some_and(|symbol| symbol.exported);
            let mut def = self.def(
                entry,
                descriptor,
                representative,
                set.clone(),
                docs,
                exported,
            );
            def.parent = parent as i32;
            if parent != 0 {
                def.qualified_name = format!("{}::{}", defs[parent].qualified_name, def.name);
            }
            defs.push(def);
            if self.javascript {
                for declaration in set {
                    self.jsdoc_properties(declaration, index, &mut defs, health);
                }
            }
        }
        assign_ordinals(path, &mut defs);
        defs
    }

    fn def<'tree, 'decl>(
        &mut self,
        entry: &Declaration<'tree>,
        descriptor: &Descriptor,
        representative: &Declaration<'tree>,
        set: impl ExactSizeIterator<Item = &'decl Declaration<'tree>> + Clone + DoubleEndedIterator,
        docstring: Option<String>,
        exported: bool,
    ) -> Def
    where
        'tree: 'decl,
    {
        let first = set.clone().next().expect("declarations");
        let last = set.clone().next_back().expect("declarations");
        let range = self.source.range(Span {
            start: first.span.start,
            end: last.span.end,
        });
        let (body_hash, sketch) = self.evidence(
            descriptor.kind,
            range.start_line,
            range.end_line,
            set.clone().map(|d| d.span),
        );

        let node = if representative.form == Form::Assignment {
            field(representative.node, "right").unwrap_or(representative.node)
        } else {
            representative.node
        };
        let flags = ["async", "static", "abstract"]
            .into_iter()
            .filter(|flag| has_modifier(node, flag))
            .map(str::to_owned)
            .collect();
        let visibility = ["private", "protected", "public"]
            .into_iter()
            .find(|flag| has_modifier(node, flag))
            .map(str::to_owned);
        let decorators = representative
            .decorators
            .iter()
            .filter_map(|&decorator| first_named(decorator))
            .map(|expression| self.source.of(expression).replace("\r\n", "\n"))
            .collect();
        let type_parameters = field(node, "type_parameters").map_or_else(Vec::new, |params| {
            let mut cursor = params.walk();
            params
                .named_children(&mut cursor)
                .filter_map(|param| field(param, "name"))
                .map(|name| syntax::declaration_name(name, self.source).into_owned())
                .collect()
        });
        let return_target = if matches!(representative.form, Form::Variable | Form::Property) {
            initializer(node)
        } else {
            Some(node)
        };
        let return_type = return_target
            .filter(|node| is_function_like(*node))
            .and_then(|node| {
                syntax::return_annotation(node, self.source).or_else(|| {
                    self.javascript
                        .then(|| annotated_return(self.source, representative))
                        .flatten()
                })
            })
            .map(|text| syntax::normalize(text, bounds::MAX_SIGNATURE_BYTES));

        let mut headers: Vec<_> = set
            .map(|d| syntax::header(d.node, d.form, d.span, self.source))
            .filter(|header| !header.is_empty())
            .collect();
        headers.sort_unstable();
        headers.dedup();
        let mut signature = String::new();
        for header in headers {
            if !signature.is_empty() {
                signature.push_str(" | ");
            }
            signature.push_str(&header);
            if signature.len() >= bounds::MAX_SIGNATURE_BYTES {
                signature.truncate(signature.floor_char_boundary(bounds::MAX_SIGNATURE_BYTES));
                break;
            }
        }
        Def {
            kind: descriptor.kind,
            name: descriptor.name.clone(),
            qualified_name: descriptor.name.clone(),
            declaration_role: Some(descriptor.role.clone()),
            signature,
            ordinal: None,
            parent: NONE,
            scope: NONE,
            range,
            name_range: self.source.range(self.source.span(entry.name)),
            exported,
            is_default_export: representative.modifier == ExportModifier::Default,
            flags,
            visibility,
            decorators,
            type_parameters,
            heritage: Vec::new(),
            return_type,
            body_hash,
            sketch,
            docstring,
        }
    }

    fn jsdoc_properties(
        &mut self,
        declaration: &Declaration<'_>,
        owner: usize,
        defs: &mut Vec<Def>,
        health: &mut Health,
    ) {
        let target = match declaration.form {
            Form::Assignment => field(declaration.node, "right"),
            Form::Variable | Form::Property => initializer(declaration.node),
            _ => Some(declaration.node),
        };
        if !target.is_some_and(is_function_like) {
            return;
        }
        let first = defs.len();
        for property in parameter_properties(self.source, declaration) {
            let range = self.source.range(property.span);
            if defs.len() == bounds::MAX_DEFS {
                definition_limit(health, range);
                break;
            }
            let owner = property.owner.map_or(owner, |i| first + i);
            let qualified_name = format!("{}::{}", defs[owner].qualified_name, property.name);
            let (body_hash, sketch) = self.evidence(
                Kind::Property,
                range.start_line,
                range.end_line,
                std::iter::once(property.span),
            );
            defs.push(Def {
                kind: Kind::Property,
                name: property.name.into(),
                qualified_name,
                declaration_role: Some("property".into()),
                signature: syntax::normalize(property.annotation, bounds::MAX_SIGNATURE_BYTES),
                ordinal: None,
                parent: owner as i32,
                scope: NONE,
                range,
                name_range: range,
                exported: false,
                is_default_export: false,
                flags: Vec::new(),
                visibility: None,
                decorators: Vec::new(),
                type_parameters: Vec::new(),
                heritage: Vec::new(),
                return_type: None,
                body_hash,
                sketch,
                docstring: property.docstring,
            });
        }
    }

    fn evidence(
        &mut self,
        kind: Kind,
        start: u32,
        end: u32,
        spans: impl Iterator<Item = Span>,
    ) -> (Option<[u8; 32]>, Option<SketchFacts>) {
        if !matches!(
            kind,
            Kind::Class
                | Kind::Interface
                | Kind::Enum
                | Kind::TypeAlias
                | Kind::Function
                | Kind::Method
                | Kind::Property
                | Kind::Constant
                | Kind::Variable
        ) {
            return (None, None);
        }
        let hash = *self
            .bodies
            .entry((start, end))
            .or_insert_with(|| body_hash(&self.source.lines, start as usize + 1, end as usize + 1));
        self.tokens.clear();
        for (i, span) in spans.enumerate() {
            if i > 0 {
                self.tokens.push("OverloadBoundary");
            }
            append_token_names(
                &self.source.fingerprint_text(span),
                self.jsx,
                &mut self.tokens,
            );
        }
        let sketch = self.sketches.sketch(&self.tokens);
        (
            Some(hash),
            Some(SketchFacts {
                minhash: sketch.minhash.to_vec(),
                token_count: sketch.token_count as u32,
            }),
        )
    }
}

fn definition_limit(health: &mut Health, range: Range) {
    health.status = ParseStatus::Partial;
    if health.diagnostics.len() < bounds::MAX_DIAGNOSTICS
        && !health
            .diagnostics
            .iter()
            .any(|issue| issue.code == "definition-limit")
    {
        health.diagnostics.push(Diagnostic {
            code: "definition-limit".into(),
            range,
        });
    }
}

fn implementation<'a, 'tree>(
    declarations: &'a [Declaration<'tree>],
    members: &[usize],
) -> &'a Declaration<'tree> {
    let mut class = None;
    let mut last = None;
    for &i in members {
        let declaration = &declarations[i];
        if declaration.form == Form::Assignment
            || is_function_like(declaration.node) && field(declaration.node, "body").is_some()
        {
            return declaration;
        }
        if declaration.form == Form::Class {
            class.get_or_insert(declaration);
        }
        last = Some(declaration);
    }
    class.or(last).expect("declarations")
}

fn assign_ordinals(path: &str, defs: &mut [Def]) {
    let mut groups: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, def) in defs.iter().enumerate() {
        groups
            .entry(def.ordinal_identity(path))
            .or_default()
            .push(i);
    }
    for mut group in groups.into_values().filter(|group| group.len() > 1) {
        group.sort_by_key(|&i| defs[i].range.start_byte);
        for (ordinal, i) in group.into_iter().enumerate() {
            defs[i].ordinal = Some(ordinal as u32);
        }
    }
}
