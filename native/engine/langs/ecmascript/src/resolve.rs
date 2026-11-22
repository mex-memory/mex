//! ECMAScript reference resolution over one immutable set of extracted facts.
//! Start each lookup at a lexical binding or an explicit module. Every member
//! lookup then needs a known receiver; absence is retained as an unresolved call.

use std::collections::{BTreeMap, HashMap};

use mex_graph_core::facts::ecmascript::{ExprId, Expression, ImportSite, Owner, Space};
use mex_graph_core::facts::{
    Call, CallForm, Def, FileFacts, ImportForm, Kind, NONE, Range, Receiver, ScopeKind,
};

use crate::modules::ModuleResolver;

mod contextual;
mod index;
mod module_links;
use index::FileIndex;

const MAX_DEPTH: usize = 48;
type Reason = &'static str;
type Lookup = Result<Value, Reason>;
pub type DefRef = (usize, usize);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Edge {
    pub from: DefRef,
    pub to: DefRef,
    pub kind: &'static str,
    /// 1-based line and UTF-16 column of the reference.
    pub line: u32,
    pub col: u32,
    pub site_file: usize,
    pub site: EdgeSite,
}

/// Evidence at the written site, indexed into that file's facts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EdgeSite {
    Import(usize),
    Heritage(usize),
    Call(usize),
    Callback { argument: u32 },
    Identifier(ExprId),
}

impl Edge {
    pub fn is_callback(&self) -> bool {
        matches!(self.site, EdgeSite::Callback { .. })
    }
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Resolution {
    pub edges: Vec<Edge>,
    pub unresolved: Vec<(usize, Reason, u32)>,
    pub unresolved_calls: Vec<(usize, usize, Reason)>,
    pub unresolved_heritage: Vec<UnresolvedHeritage>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct UnresolvedHeritage {
    pub from: DefRef,
    pub heritage: usize,
    pub reason: Reason,
}

pub struct ImportResolution {
    pub site: ImportSite,
    pub module: Result<usize, Reason>,
    pub target: Option<DefRef>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct Site {
    file: usize,
    scope: i32,
    expression: ExprId,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Value {
    Def(DefRef),
    Binding(usize, usize),
    Member(usize, usize),
    Instance(DefRef),
    ClassExpression { site: Site, is_static: bool },
    Object(Site),
    Array(Site),
    Promise(Site),
    Signature { site: Site, construct: bool },
    Module { file: usize, require: bool },
    Callable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Lane {
    Value,
    Type,
}

impl Lane {
    fn admits(self, space: Space) -> bool {
        matches!(
            (self, space),
            (_, Space::Both) | (Self::Type, Space::Type) | (Self::Value, Space::Value)
        )
    }
}

pub fn resolve(files: &[FileFacts], modules: &ModuleResolver) -> Resolution {
    Resolver::new(files, modules).resolve_all()
}

/// Schema v4 also persists the explicit name bindings used by framework resolvers.
pub fn resolve_for_stage(
    files: &[FileFacts],
    modules: &ModuleResolver,
) -> (Resolution, Vec<Vec<ImportResolution>>) {
    let mut resolver = Resolver::new(files, modules);
    let resolution = resolver.resolve_all();
    let bindings = (0..files.len())
        .map(|file| resolver.resolve_import_bindings(file))
        .collect();
    (resolution, bindings)
}

struct Resolver<'a> {
    files: &'a [FileFacts],
    index: Vec<Option<FileIndex<'a>>>,
    paths: HashMap<&'a str, usize>,
    imports: Vec<Vec<Lookup>>,
    contextual_this: HashMap<(usize, ExprId), Value>,
    export_cache: HashMap<(usize, String, Lane), Lookup>,
    // Re-export cycles are tracked per query. The cycle itself is not a failed
    // export: a different star can still name the same symbol unambiguously.
    export_stack: Vec<(usize, String, Lane)>,
}

impl<'a> Resolver<'a> {
    fn new(files: &'a [FileFacts], modules: &ModuleResolver) -> Self {
        let mut resolver = Self {
            files,
            index: files.iter().map(FileIndex::new).collect(),
            paths: files
                .iter()
                .enumerate()
                .map(|(i, f)| (f.path.as_str(), i))
                .collect(),
            imports: Vec::new(),
            contextual_this: HashMap::new(),
            export_cache: HashMap::new(),
            export_stack: Vec::new(),
        };
        resolver.imports = files
            .iter()
            .enumerate()
            .map(|(file, facts)| {
                facts
                    .imports
                    .iter()
                    .map(|import| resolver.import_target(file, import, modules))
                    .collect()
            })
            .collect();
        resolver.index_contextual_this();
        resolver
    }

    fn model(&self, file: usize) -> &FileIndex<'a> {
        self.index[file].as_ref().expect("ECMAScript file model")
    }

    fn def(&self, (file, def): DefRef) -> &'a Def {
        &self.files[file].defs[def]
    }

    fn resolve_all(&mut self) -> Resolution {
        let mut result = Resolution::default();
        for file in 0..self.files.len() {
            if self.index[file].is_some() {
                self.resolve_file(file, &mut result);
            }
        }
        result
    }

    fn resolve_import_bindings(&mut self, file: usize) -> Vec<ImportResolution> {
        let Some(index) = &self.index[file] else {
            return Vec::new();
        };
        index
            .facts
            .import_sites
            .iter()
            .map(|&site| {
                let binding = &self.files[file].imports[site.import].bindings[site.binding];
                let (module, target) = match self.imports[file][site.import] {
                    Ok(value @ Value::Module { file: target, .. }) => {
                        let target_def = if binding.imported == "*" {
                            Some((target, 0))
                        } else {
                            let lane = if binding.type_only {
                                Lane::Type
                            } else {
                                Lane::Value
                            };
                            self.member(value, &binding.imported, lane, 0)
                                .ok()
                                .and_then(|value| self.referenced(value))
                        };
                        (Ok(target), target_def)
                    }
                    Err(reason) => (Err(reason), None),
                    Ok(_) => unreachable!("import resolution only produces modules"),
                };
                ImportResolution {
                    site,
                    module,
                    target,
                }
            })
            .collect()
    }

    fn resolve_file(&mut self, file: usize, result: &mut Resolution) {
        let facts = &self.files[file];
        let extra = self.model(file).facts;
        for site in &extra.import_sites {
            if let Ok(Value::Module { file: target, .. }) = self.imports[file][site.import] {
                result.edges.push(edge(
                    (file, 0),
                    (target, 0),
                    "imports",
                    site.range,
                    EdgeSite::Import(site.import),
                ));
            }
        }
        for (import_index, import) in facts.imports.iter().enumerate() {
            if import.form == ImportForm::CommonJs
                && import.bindings.is_empty()
                && let Ok(Value::Module { file: target, .. }) = self.imports[file][import_index]
            {
                result.edges.push(edge(
                    (file, 0),
                    (target, 0),
                    "imports",
                    import.range,
                    EdgeSite::Import(import_index),
                ));
            }
        }
        for base in &extra.bases {
            let heritage = &facts.defs[base.def as usize].heritage[base.heritage];
            let from = (file, base.def as usize);
            let target = self
                .eval(file, base.scope, base.expression, 0)
                .and_then(|value| {
                    self.referenced(value)
                        .filter(|&target| {
                            matches!(
                                self.def(target).kind,
                                Kind::Class | Kind::Interface | Kind::TypeAlias
                            )
                        })
                        .ok_or("heritage_target_not_indexed")
                });
            match target {
                Ok(target) => result.edges.push(edge(
                    from,
                    target,
                    if heritage.implements {
                        "implements"
                    } else {
                        "extends"
                    },
                    heritage.range,
                    EdgeSite::Heritage(base.heritage),
                )),
                Err(reason) => result.unresolved_heritage.push(UnresolvedHeritage {
                    from,
                    heritage: base.heritage,
                    reason,
                }),
            }
        }
        let mut reasons = BTreeMap::new();
        let mut arguments = extra.arguments.iter().peekable();
        for (index, call) in facts.calls.iter().enumerate() {
            let resolved = self.resolve_call(file, call);
            let mut callback_arguments =
                std::iter::from_fn(|| arguments.next_if(|arg| arg.call == index));
            match resolved {
                Ok(target) => {
                    let kind = if call.form == CallForm::New {
                        "instantiates"
                    } else {
                        "calls"
                    };
                    result.edges.push(edge(
                        source(file, call.caller),
                        target,
                        kind,
                        call.name_range,
                        EdgeSite::Call(index),
                    ));
                    for argument in &mut callback_arguments {
                        if !self.model(target.0).invokes(target.1, argument.position) {
                            continue;
                        }
                        if let Ok(value) = self.eval(file, call.scope, argument.expression, 0)
                            && let Some(callback) = self.referenced(value)
                        {
                            result.edges.push(Edge {
                                site_file: file,
                                ..edge(
                                    target,
                                    callback,
                                    "calls",
                                    argument.range,
                                    EdgeSite::Callback {
                                        argument: argument.position,
                                    },
                                )
                            });
                        }
                    }
                }
                Err(reason) => {
                    *reasons.entry(reason).or_insert(0) += 1;
                    result.unresolved_calls.push((file, index, reason));
                }
            }
            callback_arguments.for_each(drop);
        }
        result.unresolved.extend(
            reasons
                .into_iter()
                .map(|(reason, count)| (file, reason, count)),
        );
        for reference in &extra.references {
            let from = source(file, reference.caller);
            if let Ok(value) = self.eval(file, reference.scope, reference.expression, 0)
                && let Some(target) = self.referenced(value)
                && target != from
            {
                result.edges.push(edge(
                    from,
                    target,
                    "references",
                    reference.range,
                    EdgeSite::Identifier(reference.expression),
                ));
            }
        }
    }

    fn resolve_call(&mut self, file: usize, call: &Call) -> Result<DefRef, Reason> {
        let scope = call.scope;
        if call.form == CallForm::SuperConstructor {
            let (Value::Def(base) | Value::Instance(base)) = self.super_value(file, scope, 0)?
            else {
                return Err("base_not_class");
            };
            return Ok(self.constructor(base, 0).unwrap_or(base));
        }
        let allow_interface = matches!(call.receiver, Some(Receiver::This | Receiver::Super));
        let value = match call.receiver.as_ref() {
            None if call.form != CallForm::Other => {
                self.name(file, scope, &call.name, Lane::Value, 0)?
            }
            None => return Err("complex_callee"),
            Some(receiver) => {
                let base = match receiver {
                    Receiver::This => self.this_value(file, scope, 0)?,
                    Receiver::Super => self.super_value(file, scope, 0)?,
                    Receiver::Name { name } => self.name(file, scope, name, Lane::Value, 0)?,
                    Receiver::Expression { index } => {
                        if call.form == CallForm::Other
                            && !matches!(
                                self.model(file).expression(*index),
                                Expression::Name { .. } | Expression::Member { .. }
                            )
                        {
                            return Err("complex_callee");
                        }
                        self.eval(file, scope, *index, 0)?
                    }
                    _ => return Err("dynamic_receiver"),
                };
                if call.form == CallForm::Other {
                    base
                } else {
                    self.member(base, &call.name, Lane::Value, 0)?
                }
            }
        };
        self.call_target(value, call.form == CallForm::New, allow_interface, 0)
    }

    fn call_target(
        &mut self,
        value: Value,
        new: bool,
        allow_interface: bool,
        depth: usize,
    ) -> Result<DefRef, Reason> {
        check_depth(depth)?;
        match value {
            Value::Def(def)
                if new && matches!(self.def(def).kind, Kind::Class | Kind::Function) =>
            {
                Ok(def)
            }
            Value::Def(def) if !new && self.callable_def(def) => Ok(def),
            Value::Member(file, index) => {
                let member = &self.model(file).facts.members[index];
                if !allow_interface
                    && let Owner::Definition { def, .. } = member.owner
                    && self.def((file, def as usize)).kind == Kind::Interface
                {
                    return Err("interface_dispatch");
                }
                if !member.getter && member.def != NONE {
                    let def = (file, member.def as usize);
                    if !new && self.callable_def(def) || self.callable(value, new, depth + 1) {
                        return Ok(def);
                    }
                }
                // Destructured and CommonJS imports reach a declaration by a
                // proven export. An ordinary unindexed local remains a binding.
                Err("member_not_callable")
            }
            Value::Binding(file, index) => {
                let binding = &self.model(file).facts.bindings[index];
                if self.model(file).is_module_binding(index) {
                    let target = self.bound_value(value, depth + 1)?;
                    return self.call_target(target, new, allow_interface, depth + 1);
                }
                if binding.def != NONE && self.callable(value, new, depth + 1) {
                    return Ok((file, binding.def as usize));
                }
                Err(if binding.parameter.is_some() {
                    "parameter_call"
                } else {
                    "local_value"
                })
            }
            Value::Module {
                file,
                require: true,
            } => {
                let value = self.commonjs_default(file, depth + 1)?;
                self.call_target(value, new, allow_interface, depth + 1)
            }
            _ => Err(if new {
                "constructor_unknown"
            } else {
                "callee_not_callable"
            }),
        }
    }

    fn callable_def(&self, def: DefRef) -> bool {
        matches!(self.def(def).kind, Kind::Function | Kind::Method)
            || self.model(def.0).callable_defs.contains(&(def.1 as i32))
    }

    fn callable(&mut self, value: Value, construct: bool, depth: usize) -> bool {
        if check_depth(depth).is_err() {
            return false;
        }
        match value {
            Value::Callable => !construct,
            Value::Signature {
                construct: kind, ..
            } => construct == kind,
            Value::Def(def) if construct => {
                matches!(self.def(def).kind, Kind::Class | Kind::Function)
            }
            Value::Def(def) => self.callable_def(def),
            Value::Binding(..) | Value::Member(..) => self
                .bound_value(value, depth + 1)
                .is_ok_and(|value| self.callable(value, construct, depth + 1)),
            Value::ClassExpression {
                is_static: true, ..
            } => construct,
            _ if construct => self.construct_signatures(value).is_some(),
            _ => false,
        }
    }

    fn referenced(&self, target: Value) -> Option<DefRef> {
        match target {
            Value::Def(def) | Value::Instance(def) => Some(def),
            Value::Member(file, index) => def_ref(file, self.model(file).facts.members[index].def),
            Value::Binding(file, index) => {
                def_ref(file, self.model(file).facts.bindings[index].def)
            }
            _ => None,
        }
    }

    fn name(&mut self, file: usize, scope: i32, name: &str, lane: Lane, depth: usize) -> Lookup {
        check_depth(depth)?;
        let index = self.model(file).binding(scope, name, lane)?;
        let binding = &self.model(file).facts.bindings[index];
        let value = match def_ref(file, binding.def) {
            Some(def)
                if !matches!(self.def(def).kind, Kind::Variable | Kind::Constant)
                    && !(matches!(self.def(def).kind, Kind::Interface | Kind::TypeAlias)
                        && binding.space == Space::Value
                        && binding.value.is_some()) =>
            {
                Value::Def(def)
            }
            _ => Value::Binding(file, index),
        };
        if self.model(file).is_import(index) {
            return self.eval_in(
                file,
                binding.scope,
                binding.value.ok_or("unresolved_import")?,
                lane,
                depth + 1,
            );
        }
        Ok(value)
    }

    fn as_type(&mut self, value: Value, depth: usize) -> Lookup {
        check_depth(depth)?;
        match value {
            Value::Def(def) if matches!(self.def(def).kind, Kind::Class | Kind::Interface) => {
                Ok(Value::Instance(def))
            }
            Value::Member(file, index) if self.model(file).facts.members[index].def != NONE => {
                let def = self.model(file).facts.members[index].def as usize;
                self.as_type(Value::Def((file, def)), depth + 1)
            }
            Value::Def((file, def)) if self.def((file, def)).kind == Kind::TypeAlias => {
                let alias = self
                    .model(file)
                    .aliases
                    .get(&def)
                    .copied()
                    .ok_or("type_alias_unknown")?;
                self.eval(file, alias.scope, alias.value, depth + 1)
            }
            Value::Binding(..) => self.bound_value(value, depth + 1),
            _ => Ok(value),
        }
    }

    fn eval(&mut self, file: usize, scope: i32, expression: ExprId, depth: usize) -> Lookup {
        self.eval_in(file, scope, expression, Lane::Value, depth)
    }

    fn eval_in(
        &mut self,
        file: usize,
        scope: i32,
        expression: ExprId,
        lane: Lane,
        depth: usize,
    ) -> Lookup {
        check_depth(depth)?;
        let site = Site {
            file,
            scope,
            expression,
        };
        match self.model(file).expression(expression) {
            Expression::Name { name } => self.name(file, scope, name, lane, depth + 1),
            Expression::TypeName { name } | Expression::GenericType { name, .. } => {
                let value = self.type_symbol(file, scope, name, depth + 1)?;
                self.as_type(value, depth + 1)
            }
            Expression::Intersection { .. } => Err("intersection_type"),
            Expression::Member { object, name } => {
                let value = self.eval_in(file, scope, *object, lane, depth + 1)?;
                self.member(value, name, lane, depth + 1)
            }
            Expression::Index { object } => {
                let value = self.eval(file, scope, *object, depth + 1)?;
                self.array_item(value, None, depth + 1)
            }
            Expression::Definition { def } => def_ref(file, *def)
                .map(Value::Def)
                .ok_or("missing_definition"),
            Expression::Module { import } => self.imports[file][*import],
            Expression::This => self.this_value(file, scope, depth + 1),
            Expression::Super => self.super_value(file, scope, depth + 1),
            Expression::Object => Ok(Value::Object(site)),
            Expression::Class => Ok(Value::ClassExpression {
                site,
                is_static: true,
            }),
            Expression::Array { .. } | Expression::Tuple { .. } => Ok(Value::Array(site)),
            Expression::Promise { .. } => Ok(Value::Promise(site)),
            Expression::Callable => Ok(Value::Callable),
            Expression::Signature { construct, .. } => Ok(Value::Signature {
                site,
                construct: *construct,
            }),
            Expression::New { callee } => {
                let value = self.eval(file, scope, *callee, depth + 1)?;
                self.constructed_value(value, depth + 1)
            }
            Expression::Call { callee } => {
                let value = self.eval(file, scope, *callee, depth + 1)?;
                self.call_result(value, false, depth + 1)
            }
            Expression::Await { operand } => {
                // Await can use the inferred value of an async function even
                // when a Promise wrapper was implicit in its declaration.
                if let Expression::Call { callee } = self.model(file).expression(*operand) {
                    let value = self.eval(file, scope, *callee, depth + 1)?;
                    return self.call_result(value, true, depth + 1);
                }
                let value = self.eval(file, scope, *operand, depth + 1)?;
                self.await_value(value, depth + 1)
            }
            Expression::Alternatives { values } => self.same_values(
                values.iter().map(|&expression| Site { expression, ..site }),
                depth + 1,
            ),
        }
    }

    fn same_values(&mut self, sites: impl IntoIterator<Item = Site>, depth: usize) -> Lookup {
        let mut found = None;
        for Site {
            file,
            scope,
            expression,
        } in sites
        {
            let value = self.eval(file, scope, expression, depth + 1)?;
            let value = self.peel(value, depth + 1)?;
            if found.is_some_and(|prior| prior != value) {
                return Err("ambiguous_value");
            }
            found = Some(value);
        }
        found.ok_or("unknown_value")
    }

    fn await_value(&mut self, value: Value, depth: usize) -> Lookup {
        if let Value::Promise(site) = self.peel(value, depth + 1)?
            && let Expression::Promise { element } =
                self.model(site.file).expression(site.expression)
        {
            self.eval(site.file, site.scope, *element, depth + 1)
        } else {
            Ok(value)
        }
    }

    fn call_result(&mut self, callee: Value, awaited: bool, depth: usize) -> Lookup {
        let value = self.peel(callee, depth + 1)?;
        if let Value::Signature {
            site,
            construct: false,
        } = value
        {
            let result = self.signature_result(site, depth + 1)?;
            return if awaited {
                self.await_value(result, depth + 1)
            } else {
                Ok(result)
            };
        }
        let target = self.call_target(value, false, true, depth + 1)?;
        self.return_value(target, awaited, depth + 1)
    }

    fn signature_result(&mut self, site: Site, depth: usize) -> Lookup {
        let Expression::Signature {
            returns: Some(expression),
            ..
        } = self.model(site.file).expression(site.expression)
        else {
            return Err("return_type_unknown");
        };
        self.eval(site.file, site.scope, *expression, depth + 1)
    }

    fn construct_signatures(
        &self,
        value: Value,
    ) -> Option<(
        usize,
        &[mex_graph_core::facts::ecmascript::ConstructSignature],
    )> {
        let (file, owner) = match value {
            Value::Instance((file, def)) => (
                file,
                Owner::Definition {
                    def: def as i32,
                    is_static: false,
                },
            ),
            Value::Object(site) => (
                site.file,
                Owner::Object {
                    expression: site.expression,
                },
            ),
            _ => return None,
        };
        Some((file, self.model(file).constructs.get(&owner)?))
    }

    fn constructed_value(&mut self, value: Value, depth: usize) -> Lookup {
        check_depth(depth)?;
        let value = self.peel(value, depth + 1)?;
        match value {
            Value::Def(def) if self.def(def).kind == Kind::Class => Ok(Value::Instance(def)),
            Value::ClassExpression {
                site,
                is_static: true,
            } => Ok(Value::ClassExpression {
                site,
                is_static: false,
            }),
            Value::Signature {
                site,
                construct: true,
            } => self.signature_result(site, depth + 1),
            Value::Module {
                file,
                require: true,
            } => {
                let value = self.commonjs_default(file, depth + 1)?;
                self.constructed_value(value, depth + 1)
            }
            _ => {
                let (file, signatures) = self
                    .construct_signatures(value)
                    .ok_or("constructor_type_unknown")?;
                let mut sites = Vec::with_capacity(signatures.len());
                for signature in signatures {
                    sites.push(Site {
                        file,
                        scope: signature.scope,
                        expression: signature.value.ok_or("constructor_type_unknown")?,
                    });
                }
                self.same_values(sites, depth + 1)
            }
        }
    }

    fn return_value(&mut self, (file, def): DefRef, awaited: bool, depth: usize) -> Lookup {
        let returns = self
            .model(file)
            .returns
            .get(&def)
            .cloned()
            .ok_or("return_type_unknown")?;
        let declared = returns.iter().any(|r| r.declared);
        let async_ = self
            .def((file, def))
            .flags
            .iter()
            .any(|flag| flag == "async");
        if async_ && !awaited && !declared {
            return Err("promise_value");
        }
        let relevant = returns.iter().filter(|r| r.declared == declared);
        if relevant.clone().any(|r| r.value.is_none()) {
            return Err("return_type_unknown");
        }
        let value = self.same_values(
            relevant.filter_map(|r| {
                r.value.map(|expression| Site {
                    file,
                    scope: r.scope,
                    expression,
                })
            }),
            depth + 1,
        )?;
        if awaited {
            self.await_value(value, depth + 1)
        } else {
            Ok(value)
        }
    }

    fn bound_value(&mut self, value: Value, depth: usize) -> Lookup {
        let (file, scope, expression) = match value {
            Value::Binding(file, index) => {
                let model = self.model(file);
                let binding = &model.facts.bindings[index];
                (
                    file,
                    model
                        .initializers
                        .get(&index)
                        .copied()
                        .unwrap_or(binding.scope),
                    binding.value.ok_or("untyped_binding")?,
                )
            }
            Value::Member(file, index) => {
                let member = &self.model(file).facts.members[index];
                if member.getter && member.def != NONE {
                    return self.return_value((file, member.def as usize), false, depth + 1);
                }
                (file, member.scope, member.value.ok_or("untyped_member")?)
            }
            _ => return Ok(value),
        };
        self.eval(file, scope, expression, depth + 1)
    }

    fn peel(&mut self, mut value: Value, mut depth: usize) -> Lookup {
        while matches!(value, Value::Binding(..) | Value::Member(..)) {
            check_depth(depth)?;
            // A method declaration is itself a value, even though member
            // lookup preserves which owner declared it for dispatch policy.
            if let Value::Member(file, index) = value {
                let member = &self.model(file).facts.members[index];
                if !member.getter
                    && member.def != NONE
                    && matches!(
                        self.def((file, member.def as usize)).kind,
                        Kind::Method | Kind::Function
                    )
                {
                    return Ok(Value::Def((file, member.def as usize)));
                }
            }
            value = self.bound_value(value, depth + 1)?;
            depth += 1;
        }
        Ok(value)
    }

    fn member(&mut self, value: Value, name: &str, lane: Lane, depth: usize) -> Lookup {
        check_depth(depth)?;
        let value = self.peel(value, depth + 1)?;
        match value {
            Value::Module { file, require } => self.export(file, name, lane, require, depth + 1),
            Value::Def(def) => self.definition_member(def, true, name, depth + 1),
            Value::Instance(def) => self.definition_member(def, false, name, depth + 1),
            Value::Object(site) => self.own_member(
                site.file,
                Owner::Object {
                    expression: site.expression,
                },
                name,
            ),
            Value::ClassExpression { site, is_static } => {
                let owner = Owner::ClassExpression {
                    expression: site.expression,
                    is_static,
                };
                match self.own_member(site.file, owner, name) {
                    Err("member_missing") => {
                        let base = self.class_expression_base(site, is_static, depth + 1)?;
                        self.member(base, name, lane, depth + 1)
                    }
                    own => own,
                }
            }
            Value::Array(_) => name
                .parse()
                .map_err(|_| "builtin_member")
                .and_then(|index| self.array_item(value, Some(index), depth + 1)),
            _ => Err("receiver_type_unknown"),
        }
    }

    fn own_member(&self, file: usize, owner: Owner, name: &str) -> Lookup {
        self.model(file)
            .member(owner, name)
            .map(|i| Value::Member(file, i))
    }

    fn definition_member(
        &mut self,
        (file, def): DefRef,
        is_static: bool,
        name: &str,
        depth: usize,
    ) -> Lookup {
        check_depth(depth)?;
        let owner = Owner::Definition {
            def: def as i32,
            is_static,
        };
        let own = self.own_member(file, owner, name);
        if own != Err("member_missing") {
            return own;
        }
        let mut winner = None;
        let bases = self
            .model(file)
            .bases
            .get(&def)
            .cloned()
            .unwrap_or_default();
        for base in bases {
            if self.def((file, def)).heritage[base.heritage].implements {
                continue;
            }
            let resolved = self.eval(file, base.scope, base.expression, depth + 1)?;
            let resolved = self.peel(resolved, depth + 1)?;
            let (Value::Def(parent) | Value::Instance(parent)) = resolved else {
                return Err("base_type_unknown");
            };
            match self.definition_member(parent, is_static, name, depth + 1) {
                Ok(value) if winner.is_some_and(|prior| prior != value) => {
                    return Err("ambiguous_member");
                }
                Ok(value) => winner = Some(value),
                Err("member_missing") => {}
                Err(reason) => return Err(reason),
            }
        }
        winner.ok_or("member_missing")
    }

    fn array_item(&mut self, value: Value, index: Option<usize>, depth: usize) -> Lookup {
        let Value::Array(site) = self.peel(value, depth + 1)? else {
            return Err("item_type_unknown");
        };
        match self.model(site.file).expression(site.expression) {
            Expression::Array {
                element: Some(expression),
            } => self.eval(site.file, site.scope, *expression, depth + 1),
            Expression::Tuple { elements } => {
                if let Some(index) = index {
                    let expression = elements
                        .get(index)
                        .copied()
                        .flatten()
                        .ok_or("item_type_unknown")?;
                    self.eval(site.file, site.scope, expression, depth + 1)
                } else if elements.iter().all(Option::is_some) {
                    self.same_values(
                        elements
                            .iter()
                            .flatten()
                            .map(|&expression| Site { expression, ..site }),
                        depth + 1,
                    )
                } else {
                    Err("item_type_unknown")
                }
            }
            _ => Err("item_type_unknown"),
        }
    }

    fn this_owner(&self, file: usize, mut scope: i32) -> Result<Owner, Reason> {
        while scope != NONE {
            if let Some(&owner) = self.model(file).this_bindings.get(&scope) {
                return Ok(owner);
            }
            let current = &self.files[file].scopes[scope as usize];
            if matches!(
                current.kind,
                ScopeKind::Function | ScopeKind::Class | ScopeKind::Module
            ) {
                break;
            }
            scope = current.parent;
        }
        Err("unbound_this")
    }

    fn this_value(&mut self, file: usize, mut scope: i32, depth: usize) -> Lookup {
        check_depth(depth)?;
        while scope != NONE {
            let model = self.model(file);
            if let Some(&expression) = model.explicit_this.get(&scope) {
                return self.eval(file, scope, expression, depth + 1);
            }
            if let Some(&owner) = model.this_bindings.get(&scope) {
                return self.owner_value(file, scope, owner);
            }
            let current = &self.files[file].scopes[scope as usize];
            if matches!(
                current.kind,
                ScopeKind::Function | ScopeKind::Class | ScopeKind::Module
            ) {
                break;
            }
            scope = current.parent;
        }
        Err("unbound_this")
    }

    fn owner_value(&self, file: usize, scope: i32, owner: Owner) -> Lookup {
        match owner {
            Owner::Definition { def, is_static } => def_ref(file, def)
                .map(|owner| {
                    if is_static {
                        Value::Def(owner)
                    } else {
                        Value::Instance(owner)
                    }
                })
                .ok_or("unbound_this"),
            Owner::Object { expression } => Ok(self
                .contextual_this
                .get(&(file, expression))
                .copied()
                .unwrap_or(Value::Object(Site {
                    file,
                    scope,
                    expression,
                }))),
            Owner::ClassExpression {
                expression,
                is_static,
            } => Ok(Value::ClassExpression {
                site: Site {
                    file,
                    scope,
                    expression,
                },
                is_static,
            }),
        }
    }

    fn super_class(&mut self, (file, def): DefRef, depth: usize) -> Result<DefRef, Reason> {
        check_depth(depth)?;
        let base = self
            .model(file)
            .bases
            .get(&def)
            .and_then(|bases| {
                bases
                    .iter()
                    .find(|base| !self.def((file, def)).heritage[base.heritage].implements)
            })
            .copied()
            .ok_or("no_base_class")?;
        let value = self.eval(file, base.scope, base.expression, depth + 1)?;
        match self.peel(value, depth + 1)? {
            Value::Def(base) if self.def(base).kind == Kind::Class => Ok(base),
            _ => Err("base_not_class"),
        }
    }

    fn super_value(&mut self, file: usize, scope: i32, depth: usize) -> Lookup {
        match self.this_owner(file, scope)? {
            Owner::Definition { def, is_static } => {
                let base =
                    self.super_class(def_ref(file, def).ok_or("no_base_class")?, depth + 1)?;
                Ok(if is_static {
                    Value::Def(base)
                } else {
                    Value::Instance(base)
                })
            }
            Owner::ClassExpression {
                expression,
                is_static,
            } => self.class_expression_base(
                Site {
                    file,
                    scope,
                    expression,
                },
                is_static,
                depth + 1,
            ),
            Owner::Object { .. } => Err("no_base_class"),
        }
    }

    fn class_expression_base(&mut self, site: Site, is_static: bool, depth: usize) -> Lookup {
        check_depth(depth)?;
        let (scope, expression) = self
            .model(site.file)
            .class_bases
            .get(&site.expression)
            .copied()
            .ok_or("no_base_class")?;
        let base = self.eval(site.file, scope, expression, depth + 1)?;
        match self.peel(base, depth + 1)? {
            Value::Def(def) if self.def(def).kind == Kind::Class => Ok(if is_static {
                Value::Def(def)
            } else {
                Value::Instance(def)
            }),
            Value::ClassExpression {
                site,
                is_static: true,
            } => Ok(Value::ClassExpression { site, is_static }),
            _ => Err("base_not_class"),
        }
    }

    fn constructor(&mut self, (file, def): DefRef, depth: usize) -> Option<DefRef> {
        check_depth(depth).ok()?;
        let owner = Owner::Definition {
            def: def as i32,
            is_static: false,
        };
        if let Ok(member) = self.own_member(file, owner, "constructor") {
            return self.referenced(member);
        }
        let base = self.super_class((file, def), depth + 1).ok()?;
        self.constructor(base, depth + 1)
    }
}

fn check_depth(depth: usize) -> Result<(), Reason> {
    if depth > MAX_DEPTH {
        Err("resolution_depth_limit")
    } else {
        Ok(())
    }
}

fn def_ref(file: usize, def: i32) -> Option<DefRef> {
    usize::try_from(def).ok().map(|def| (file, def))
}

fn source(file: usize, caller: i32) -> DefRef {
    (file, usize::try_from(caller).unwrap_or(0))
}

fn edge(from: DefRef, to: DefRef, kind: &'static str, range: Range, site: EdgeSite) -> Edge {
    Edge {
        from,
        to,
        kind,
        line: range.start_line + 1,
        col: range.start_col,
        site_file: from.0,
        site,
    }
}
