//! Positions are projection inputs. The resolvers consume the topology,
//! declaration identities, and the contents and order of the fact arenas.

use std::collections::{HashMap, HashSet};

use mex_graph_core::facts::ecmascript::{ExprId, Expression, Owner, ReferenceFacts};
use mex_graph_core::facts::{FileFacts, Kind, Range, ReferenceKind};

use crate::is_compiler_language;

type Site = (u32, Option<u32>);
pub(super) type Sites = HashMap<Site, Site>;

#[derive(bincode::Encode, bincode::Decode)]
pub(super) struct Signature {
    resolution: [u8; 32],
    surface: [u8; 32],
    sites: Vec<Site>,
}

impl Signature {
    pub(super) fn new(facts: &FileFacts) -> Result<Self, crate::job::JobError> {
        use sha2::{Digest, Sha256};
        fn hash(file: &FileFacts) -> Result<[u8; 32], crate::job::JobError> {
            let bytes = bincode::encode_to_vec(file, bincode::config::standard())
                .map_err(crate::job::JobError::write)?;
            Ok(Sha256::digest(bytes).into())
        }
        let mut file = facts.clone();
        // Activation appends routes and writes their indices to markers.
        // Framework detection itself is part of the input proof.
        file.defs.retain(|def| def.kind != Kind::Route);
        for marker in &mut file.frameworks {
            marker.def = mex_graph_core::facts::NONE;
        }
        let sites = normalize(&mut file);
        let resolution = hash(&file)?;
        keep_surface(&mut file);
        Ok(Self {
            resolution,
            surface: hash(&file)?,
            sites,
        })
    }

    pub(super) fn same_surface(&self, new: &Self) -> bool {
        self.surface == new.surface
    }

    pub(super) fn positions(&self, new: &Self) -> Option<Sites> {
        if self.resolution != new.resolution || self.sites.len() != new.sites.len() {
            return None;
        }
        let mut before = HashMap::new();
        let mut after = HashMap::new();
        for (&from, &to) in self.sites.iter().zip(&new.sites) {
            // Only translate a bijection so site deduplication is preserved.
            // An ambiguous correspondence takes the bounded resolver path.
            if before.insert(from, to).is_some_and(|old| old != to)
                || after.insert(to, from).is_some_and(|old| old != from)
            {
                return None;
            }
        }
        Some(before)
    }
}

fn keep_surface(file: &mut FileFacts) {
    if let Some(extra) = &mut file.ecmascript {
        // A contextual call can type an object that escapes the file.
        // Keep its entire arena when there is contextual evidence.
        if !extra.contextual_calls.is_empty() {
            return;
        }
        file.calls.clear();
        extra.references.clear();
        extra.arguments.clear();
        retain_surface_bindings(&file.defs, &file.scopes, &file.imports, extra);
        prune_expressions(extra);
    } else {
        file.calls.clear();
    }
    file.syntax_references.retain(|reference| {
        !matches!(
            reference.kind,
            ReferenceKind::Calls | ReferenceKind::Instantiates
        )
    });
    if file.language == "python" {
        let mut visible_scopes: HashSet<_> = file
            .defs
            .iter()
            .enumerate()
            .filter_map(|(i, d)| {
                (!matches!(d.kind, Kind::Function | Kind::Method)).then_some(i as i32)
            })
            .collect();
        visible_scopes.extend(file.defs.iter().map(|def| def.parent));
        file.bindings.retain(|binding| {
            binding.field_of.is_some() || visible_scopes.contains(&binding.scope)
        });
    }
}

// A lexical binding matters outside the edited origin only if a declaration,
// import, exported value or other retained evidence can look it up. An
// unvisited function or block may still contain calls that use that binding.
fn retain_surface_bindings(
    defs: &[mex_graph_core::facts::Def],
    scopes: &[mex_graph_core::facts::Scope],
    imports: &[mex_graph_core::facts::Import],
    facts: &mut ReferenceFacts,
) {
    let roots = defs
        .iter()
        .map(|def| def.scope)
        .chain(imports.iter().map(|import| import.scope))
        .chain(facts.initializer_scopes.iter().map(|&(_, scope)| scope))
        .chain(facts.members.iter().map(|member| member.scope))
        .chain(facts.explicit_this.iter().map(|&(scope, _)| scope))
        .chain(facts.bases.iter().map(|base| base.scope))
        .chain(facts.class_bases.iter().map(|&(_, scope, _)| scope))
        .chain(facts.formal_types.iter().map(|formal| formal.scope))
        .chain(facts.returns.iter().map(|returned| returned.scope))
        .chain(facts.type_aliases.iter().map(|alias| alias.scope))
        .chain(
            facts
                .construct_signatures
                .iter()
                .map(|signature| signature.scope),
        )
        .chain(facts.export_values.iter().map(|export| export.scope))
        .chain(facts.parameter_calls.iter().map(|call| call.scope));
    let mut retained = HashSet::from([mex_graph_core::facts::NONE]);
    for mut root in roots {
        while retained.insert(root) {
            let Some(scope) = scopes.get(root as usize) else {
                break;
            };
            root = scope.parent;
        }
    }
    let mut remap = Vec::with_capacity(facts.bindings.len());
    let mut next = 0;
    facts.bindings.retain(|binding| {
        let keep = binding.def >= 0 || retained.contains(&binding.scope);
        remap.push(keep.then_some(next));
        next += usize::from(keep);
        keep
    });
    facts.initializer_scopes.retain_mut(|(binding, _)| {
        if let Some(index) = remap[*binding] {
            *binding = index;
            true
        } else {
            false
        }
    });
}

fn normalize(file: &mut FileFacts) -> Vec<Site> {
    let mut sites = Vec::new();
    let compiler = is_compiler_language(&file.language);
    let python = file.language == "python";
    let mut site = |range: &mut Range, column| {
        sites.push((range.start_line + 1, column));
        *range = Range::default();
    };
    file.content_hash = [0; 32];
    let status = file.health.status;
    file.health = Default::default();
    file.health.status = status;
    for def in &mut file.defs {
        def.docstring = None;
        def.sketch = None;
        def.body_hash = None;
        def.name_range = Range::default();
        if def.kind == Kind::File {
            def.range = Range::default();
        } else {
            let col = compiler.then_some(def.range.start_col);
            site(&mut def.range, col);
        }
        for base in &mut def.heritage {
            let col = base.range.start_col;
            site(&mut base.range, Some(col));
        }
    }
    for import in &mut file.imports {
        let col = if python { 0 } else { import.range.start_col };
        site(&mut import.range, Some(col));
    }
    for export in &mut file.exports {
        export.range = Range::default();
    }
    for call in &mut file.calls {
        call.range = Range::default();
        let col = call.name_range.start_col;
        site(&mut call.name_range, Some(col));
    }
    for marker in &mut file.frameworks {
        if marker.kind == crate::frameworks::DETECTION {
            continue;
        }
        // Contains rows omit the column, while route links use column zero.
        sites.push((marker.range.start_line + 1, None));
        sites.push((marker.range.start_line + 1, Some(0)));
        marker.range = Range::default();
    }
    for reference in &mut file.syntax_references {
        let col = reference.range.start_col;
        sites.push((reference.range.start_line + 1, Some(col)));
        reference.range = Range::default();
    }
    if let Some(extra) = &mut file.ecmascript {
        for range in extra
            .import_sites
            .iter_mut()
            .map(|x| &mut x.range)
            .chain(extra.references.iter_mut().map(|x| &mut x.range))
            .chain(extra.arguments.iter_mut().map(|x| &mut x.range))
        {
            sites.push((range.start_line + 1, Some(range.start_col)));
            *range = Range::default();
        }
        for export in &mut extra.export_values {
            export.range = Range::default();
        }
    }
    sites
}

fn visit_roots(facts: &mut ReferenceFacts, mut visit: impl FnMut(&mut ExprId)) {
    fn owner(owner: &mut Owner) -> Option<&mut ExprId> {
        match owner {
            Owner::Definition { .. } => None,
            Owner::Object { expression } | Owner::ClassExpression { expression, .. } => {
                Some(expression)
            }
        }
    }
    for binding in &mut facts.bindings {
        binding.value.iter_mut().for_each(&mut visit);
    }
    for member in &mut facts.members {
        owner(&mut member.owner).into_iter().for_each(&mut visit);
        member.value.iter_mut().for_each(&mut visit);
    }
    for binding in &mut facts.this_bindings {
        owner(&mut binding.owner).into_iter().for_each(&mut visit);
    }
    for (_, id) in &mut facts.explicit_this {
        visit(id);
    }
    for base in &mut facts.bases {
        visit(&mut base.expression);
    }
    for (class, _, base) in &mut facts.class_bases {
        visit(class);
        visit(base);
    }
    for formal in &mut facts.formal_types {
        visit(&mut formal.expression);
    }
    for returned in &mut facts.returns {
        returned.value.iter_mut().for_each(&mut visit);
    }
    for alias in &mut facts.type_aliases {
        visit(&mut alias.value);
    }
    for signature in &mut facts.construct_signatures {
        owner(&mut signature.owner).into_iter().for_each(&mut visit);
        signature.value.iter_mut().for_each(&mut visit);
    }
    for export in &mut facts.export_values {
        export.value.iter_mut().for_each(&mut visit);
    }
    for call in &mut facts.parameter_calls {
        visit(&mut call.expression);
    }
}

fn visit_children(expr: &mut Expression, mut visit: impl FnMut(&mut ExprId)) {
    use Expression::*;
    match expr {
        GenericType { arguments, .. }
        | Tuple {
            elements: arguments,
        } => arguments.iter_mut().flatten().for_each(&mut visit),
        Alternatives { values } | Intersection { parts: values } => {
            values.iter_mut().for_each(&mut visit)
        }
        Member { object, .. } | Index { object } => visit(object),
        Call { callee } | New { callee } => visit(callee),
        Await { operand } | Promise { element: operand } => visit(operand),
        Array { element }
        | Signature {
            returns: element, ..
        } => element.iter_mut().for_each(&mut visit),
        Name { .. }
        | TypeName { .. }
        | Definition { .. }
        | Module { .. }
        | Object
        | Class
        | This
        | Super
        | Callable => {}
    }
}

// An inserted call can allocate entries anywhere in the expression arena.
// Compact to just the surface roots while retaining distinct object/class
// identities and sharing between those roots.
fn prune_expressions(facts: &mut ReferenceFacts) {
    let mut pending = Vec::new();
    visit_roots(facts, |id| pending.push(*id));
    let mut remap = vec![None; facts.expressions.len()];
    while let Some(id) = pending.pop() {
        if remap[id as usize].replace(0).is_none() {
            visit_children(&mut facts.expressions[id as usize], |id| pending.push(*id));
        }
    }
    for (next, id) in remap.iter_mut().flatten().enumerate() {
        *id = next as ExprId;
    }
    let mut index = 0;
    facts.expressions.retain_mut(|expr| {
        let keep = remap[index].is_some();
        index += 1;
        if keep {
            visit_children(expr, |id| {
                *id = remap[*id as usize].expect("a reachable expression")
            });
        }
        keep
    });
    visit_roots(facts, |id| {
        *id = remap[*id as usize].expect("a surface root")
    });
}
