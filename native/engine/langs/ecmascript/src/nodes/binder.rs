//! The per-file portion of the TypeScript binder. The same spelling can
//! occupy different symbol tables, or create a detached symbol when the new
//! declaration excludes a meaning already present in the table.
use std::collections::{HashMap, HashSet};

use tree_sitter::Node;

use super::source::Source;
use super::syntax::{
    access, declaration_name, field, first_named, is_identifier, is_string_literal, token,
};

pub(super) type SymbolId = usize;
pub(super) type TableId = usize;

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Meaning {
    Var,
    Lexical,
    Parameter,
    Property,
    AutoAccessor,
    EnumMember,
    Function,
    Class,
    Interface,
    ConstEnum,
    Enum,
    ValueModule,
    Namespace,
    Method,
    ObjectMethod,
    Getter,
    Setter,
    TypeAlias,
    Alias,
}

impl Meaning {
    // SymbolFlags and the corresponding Excludes in TypeScript 5.9.3.
    fn flags(self) -> (u32, u32) {
        match self {
            Self::Var => (1, 111_550),
            Self::Lexical => (2, 111_551),
            Self::Parameter => (1, 111_551),
            Self::Property => (4, 0),
            Self::AutoAccessor => (98_304, 13_247),
            Self::EnumMember => (8, 900_095),
            Self::Function => (16, 110_991),
            Self::Class => (32, 899_503),
            Self::Interface => (64, 788_872),
            Self::ConstEnum => (128, 899_967),
            Self::Enum => (256, 899_327),
            Self::ValueModule => (512, 110_735),
            Self::Namespace => (1024, 0),
            Self::Method => (8192, 103_359),
            Self::ObjectMethod => (8192, 0),
            Self::Getter => (32_768, 46_015),
            Self::Setter => (65_536, 78_783),
            Self::TypeAlias => (524_288, 788_968),
            Self::Alias => (2_097_152, 2_097_152),
        }
    }
}

#[derive(Clone, Copy)]
pub(super) struct Scope {
    pub locals: TableId,
    pub block: TableId,
    pub module: Option<TableId>,
    pub members: Option<(TableId, TableId)>,
    pub implicit_exports: bool,
    pub strict: bool,
    pub ambient: bool,
}

#[derive(Default)]
pub(super) struct Symbol {
    flags: u32,
    pub declarations: Vec<usize>,
    pub members: Option<TableId>,
    pub exports: Option<TableId>,
    export_symbol: Option<SymbolId>,
    pub exported: bool,
    pub require_alias: bool,
    pub expando_initializer: bool,
}

impl Symbol {
    fn can_bind_expando(&self) -> bool {
        const EXPANDO_MEANINGS: u32 = 16 | 32 | 1024; // Function, Class, NamespaceModule
        self.flags & EXPANDO_MEANINGS != 0 || self.expando_initializer
    }
}

#[derive(Default)]
struct Table {
    names: HashMap<String, SymbolId>,
    parent: Option<TableId>,
}

struct ExportAlias<'tree> {
    table: TableId,
    locals: TableId,
    value: Node<'tree>,
}

/// An assignment is queued because the right-hand name, or the receiver of
/// a JS expando, may be declared later in the file.
struct Assignment<'tree> {
    scope: Scope,
    left: Node<'tree>,
    right: Node<'tree>,
    function_draft: Option<usize>,
}

pub(super) struct Binder<'tree> {
    tables: Vec<Table>,
    pub symbols: Vec<Symbol>,
    esm: bool,
    javascript: bool,
    exports: TableId,
    aliases: Vec<ExportAlias<'tree>>,
    export_equals: Option<ExportAlias<'tree>>,
    assignments: Vec<Assignment<'tree>>,
}

impl<'tree> Binder<'tree> {
    pub fn new(esm: bool, javascript: bool) -> Self {
        Self {
            tables: vec![Table::default(), Table::default()],
            symbols: Vec::new(),
            esm,
            javascript,
            exports: 1,
            aliases: Vec::new(),
            export_equals: None,
            assignments: Vec::new(),
        }
    }

    pub fn source_scope(&self, ambient: bool, strict: bool, implicit_exports: bool) -> Scope {
        Scope {
            locals: 0,
            block: 0,
            module: self.esm.then_some(self.exports),
            members: None,
            strict: self.esm || strict,
            implicit_exports,
            ambient,
        }
    }

    fn table(&mut self, parent: Option<TableId>) -> TableId {
        let id = self.tables.len();
        self.tables.push(Table {
            parent,
            ..Table::default()
        });
        id
    }

    pub fn block(&mut self, scope: Scope) -> Scope {
        Scope {
            block: self.table(Some(scope.block)),
            ..scope
        }
    }

    pub fn local_scope(&mut self, outer: Scope) -> Scope {
        let locals = self.table(Some(outer.block));
        Scope {
            locals,
            block: locals,
            module: None,
            members: None,
            implicit_exports: false,
            ..outer
        }
    }

    fn symbol(&mut self) -> SymbolId {
        let id = self.symbols.len();
        self.symbols.push(Symbol::default());
        id
    }

    fn exports(&mut self, symbol: SymbolId) -> TableId {
        if let Some(table) = self.symbols[symbol].exports {
            return table;
        }
        let table = self.table(None);
        self.symbols[symbol].exports = Some(table);
        table
    }

    pub fn namespace(
        &mut self,
        outer: Scope,
        symbol: SymbolId,
        ambient: bool,
        implicit_exports: bool,
    ) -> Scope {
        Scope {
            module: Some(self.exports(symbol)),
            ambient,
            implicit_exports,
            ..self.local_scope(outer)
        }
    }

    pub fn member_scope(
        &mut self,
        outer: Scope,
        symbol: Option<SymbolId>,
        separate_statics: bool,
    ) -> Scope {
        let instance = symbol
            .and_then(|i| self.symbols[i].members)
            .unwrap_or_else(|| {
                let table = self.table(None);
                if let Some(i) = symbol {
                    self.symbols[i].members = Some(table);
                }
                table
            });
        let statics = match (separate_statics, symbol) {
            (true, Some(symbol)) => self.exports(symbol),
            (true, None) => self.table(None),
            (false, _) => instance,
        };
        Scope {
            members: Some((instance, statics)),
            ..self.local_scope(outer)
        }
    }

    fn declare(
        &mut self,
        table: TableId,
        name: &str,
        flags: u32,
        excludes: u32,
        declaration: Option<usize>,
    ) -> SymbolId {
        let symbol = match self.tables[table].names.get(name).copied() {
            Some(symbol) if self.symbols[symbol].flags & excludes == 0 => symbol,
            Some(_) => self.symbol(),
            None => {
                let symbol = self.symbol();
                self.tables[table].names.insert(name.to_owned(), symbol);
                symbol
            }
        };
        let entry = &mut self.symbols[symbol];
        entry.flags |= flags;
        if let Some(declaration) = declaration {
            entry.declarations.push(declaration);
        }
        symbol
    }

    pub fn member(
        &mut self,
        scope: Scope,
        is_static: bool,
        name: &str,
        meaning: Meaning,
        decl: usize,
    ) -> Option<SymbolId> {
        let (instance, statics) = scope.members?;
        let (flags, excludes) = meaning.flags();
        Some(self.declare(
            if is_static { statics } else { instance },
            name,
            flags,
            excludes,
            Some(decl),
        ))
    }

    pub fn local(
        &mut self,
        table: TableId,
        name: &str,
        meaning: Meaning,
        decl: Option<usize>,
    ) -> SymbolId {
        let (flags, excludes) = meaning.flags();
        self.declare(table, name, flags, excludes, decl)
    }

    /// A module symbol has two tables. Exported declarations are entered in
    /// the export table with their real flags, and in locals with the
    /// ExportValue marker (or no flags for a type). A local declaration can
    /// share the latter symbol without sharing the exported symbol.
    pub fn declaration(
        &mut self,
        scope: Scope,
        name: &str,
        meaning: Meaning,
        decl: usize,
        visibility: ExportModifier,
    ) -> SymbolId {
        let table = match meaning {
            Meaning::Var | Meaning::Alias => scope.locals,
            Meaning::Function if !scope.strict => scope.locals,
            _ => scope.block,
        };
        if let Some(exports) = scope.module
            && table == scope.locals
            && meaning != Meaning::Alias
            && (visibility.is_export()
                || visibility == ExportModifier::None && scope.implicit_exports)
        {
            const VALUE: u32 = 111_551;
            const EXPORT_VALUE: u32 = 1_048_576;
            let (flags, excludes) = meaning.flags();
            let local = self.declare(
                table,
                name,
                if flags & VALUE != 0 { EXPORT_VALUE } else { 0 },
                excludes,
                Some(decl),
            );
            let name = if visibility == ExportModifier::Default {
                "default"
            } else {
                name
            };
            let exported = self.declare(exports, name, flags, excludes, Some(decl));
            self.symbols[local].export_symbol = Some(exported);
            exported
        } else {
            self.local(table, name, meaning, Some(decl))
        }
    }

    pub fn record_export(&mut self, node: Node<'tree>, scope: Scope) {
        let Some(table) = scope.module else { return };
        if field(node, "source").is_some() || field(node, "declaration").is_some() {
            return;
        }
        if let Some(clause) = token(node, "export_clause") {
            let mut cursor = clause.walk();
            for specifier in clause.named_children(&mut cursor) {
                if let Some(value) = field(specifier, "name") {
                    self.aliases.push(ExportAlias {
                        table,
                        locals: scope.locals,
                        value,
                    });
                }
            }
        } else if let Some(value) = field(node, "value").or_else(|| first_named(node)) {
            let alias = ExportAlias {
                table,
                locals: scope.locals,
                value,
            };
            if token(node, "=").is_some() && table == self.exports {
                self.export_equals = Some(alias);
            } else if token(node, "default").is_some() {
                self.aliases.push(alias);
            }
        }
    }

    pub fn record_assignment(
        &mut self,
        node: Node<'tree>,
        scope: Scope,
        function_draft: Option<usize>,
    ) {
        if self.javascript
            && let (Some(left), Some(right)) = (field(node, "left"), field(node, "right"))
            && access(left).is_some()
        {
            self.assignments.push(Assignment {
                scope,
                left,
                right,
                function_draft,
            });
        }
    }

    fn lookup(&self, mut table: TableId, name: &str) -> Option<SymbolId> {
        loop {
            if let Some(&symbol) = self.tables[table].names.get(name) {
                return Some(self.symbols[symbol].export_symbol.unwrap_or(symbol));
            }
            table = self.tables[table].parent?;
        }
    }

    fn resolve(&self, table: TableId, mut node: Node, source: &Source<'_>) -> Option<SymbolId> {
        let mut members = Vec::new();
        while let Some((object, property)) = access(node) {
            if node.kind() == "subscript_expression" && !is_string_literal(property) {
                return None;
            }
            members.push(declaration_name(property, source));
            node = object;
        }
        if !is_identifier(node) {
            return None;
        }
        let mut symbol = self.lookup(table, &declaration_name(node, source))?;
        for member in members.into_iter().rev() {
            let exports = self.symbols[symbol].exports?;
            symbol = *self.tables[exports].names.get(member.as_ref())?;
        }
        Some(symbol)
    }

    /// Finish export aliases and JS property assignments. The exports of an
    /// `export = X` or `module.exports = X` module are X's exported members.
    /// The assignment does not export the local declaration X itself.
    pub fn finish(&mut self, source: &Source<'_>) -> Vec<(usize, SymbolId)> {
        let mut assignment_symbols = Vec::new();
        for assignment in std::mem::take(&mut self.assignments) {
            let (receiver, property) = access(assignment.left).expect("access assignment");
            if assignment.left.kind() == "subscript_expression" && !is_string_literal(property) {
                continue;
            }
            let locals = assignment.scope.block;
            let name = declaration_name(property, source);
            if !self.esm && is_module_exports(assignment.left, source) {
                let mut value = assignment.right;
                while value.kind() == "assignment_expression" {
                    let Some(rhs) = field(value, "right") else {
                        break;
                    };
                    value = rhs;
                }
                let empty_object = value.kind() == "object" && first_named(value).is_none();
                if !empty_object && !is_cjs_receiver(value, source) {
                    self.export_equals = Some(ExportAlias {
                        table: self.exports,
                        locals,
                        value,
                    });
                }
                continue;
            }
            let exports = if !self.esm && is_cjs_receiver(receiver, source) {
                self.exports
            } else if let Some(receiver) = self.resolve(locals, receiver, source)
                && self.symbols[receiver].can_bind_expando()
            {
                self.exports(receiver)
            } else {
                continue;
            };
            if let Some(decl) = assignment.function_draft {
                let symbol = self.local(exports, &name, Meaning::Property, None);
                assignment_symbols.push((decl, symbol));
            } else if is_identifier(assignment.right) || access(assignment.right).is_some() {
                self.aliases.push(ExportAlias {
                    table: exports,
                    locals,
                    value: assignment.right,
                });
            }
        }

        let effective = if let Some(alias) = &self.export_equals {
            self.resolve(alias.locals, alias.value, source)
                .and_then(|i| self.symbols[i].exports)
        } else {
            Some(self.exports)
        };
        if let Some(table) = effective {
            let mut exports: HashSet<SymbolId> =
                self.tables[table].names.values().copied().collect();
            exports.extend(
                self.aliases
                    .iter()
                    .filter(|alias| alias.table == table)
                    .filter_map(|alias| self.resolve(alias.locals, alias.value, source)),
            );
            for exported in exports {
                self.symbols[exported].exported = true;
            }
        }
        assignment_symbols
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum ExportModifier {
    None,
    Export,
    Default,
    /// Ambient external modules always bind as local symbols.
    AmbientModule,
}

impl ExportModifier {
    pub fn is_export(self) -> bool {
        matches!(self, Self::Export | Self::Default)
    }
}

fn is_cjs_receiver(node: Node, source: &Source<'_>) -> bool {
    node.kind() == "identifier" && source.of(node) == "exports" || is_module_exports(node, source)
}

fn is_module_exports(node: Node, source: &Source<'_>) -> bool {
    access(node).is_some_and(|(receiver, property)| {
        receiver.kind() == "identifier"
            && source.of(receiver) == "module"
            && (node.kind() == "member_expression" || is_string_literal(property))
            && declaration_name(property, source) == "exports"
    })
}
