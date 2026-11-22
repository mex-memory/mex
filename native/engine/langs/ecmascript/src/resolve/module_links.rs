use mex_graph_core::facts::ecmascript::ExportValue;
use mex_graph_core::facts::{ImportForm, Kind, NONE};

use crate::modules::{ModuleTarget, Syntax};

use super::index::ExportEntry;
use super::{Lane, Lookup, ModuleLookup, Resolver, Value, check_depth, def_ref};

impl Resolver<'_, '_> {
    pub(super) fn import(&self, file: usize, index: usize) -> Lookup {
        let facts = self.files.get(file);
        let import = &facts.imports[index];
        let require = import.form == ImportForm::CommonJs;
        if require
            && import.bindings.is_empty()
            && self.model(file).has_binding(import.scope, "require")
        {
            return Err("shadowed_require");
        }
        let syntax = if require {
            Syntax::Require
        } else {
            Syntax::Import
        };
        let key = if require { "ts-require" } else { "ts-import" };
        // The unresolved lookup is a dependency too: adding a previously
        // missing module can change this answer with no old graph edge.
        let targets = self.imports[file].get_or_init(|| {
            (0..facts.imports.len())
                .map(|_| Default::default())
                .collect()
        });
        let lookup = targets[index].get_or_init(|| ModuleLookup {
            key: format!("{}\0{}", facts.path, import.specifier),
            target: self.modules.resolve(&facts.path, &import.specifier, syntax),
        });
        self.files.lookup(key, &lookup.key);
        match &lookup.target {
            ModuleTarget::File { path, .. } => {
                let file = self
                    .paths
                    .get(path.as_str())
                    .copied()
                    .ok_or("module_not_indexed")?;
                if self.files.get(file).ecmascript.is_none() {
                    return Err("module_not_indexed");
                }
                Ok(Value::Module { file, require })
            }
            ModuleTarget::External { .. } => Err("external_module"),
            ModuleTarget::Builtin { .. } => Err("builtin_module"),
            ModuleTarget::Ambiguous { .. } => Err("ambiguous_module"),
            ModuleTarget::Namespace { .. } => Err("namespace_module_without_file"),
            ModuleTarget::Unresolved { reason } => Err(reason),
        }
    }

    pub(super) fn commonjs_default(&mut self, file: usize, depth: usize) -> Lookup {
        check_depth(depth)?;
        let export = self.model(file).commonjs.ok_or("module_not_callable")?;
        self.value_export(file, export, depth + 1)
    }

    pub(super) fn export(
        &mut self,
        file: usize,
        name: &str,
        lane: Lane,
        require: bool,
        depth: usize,
    ) -> Lookup {
        check_depth(depth)?;
        let root = self.export_stack.is_empty();
        let key = (file, name.to_owned(), lane);
        let cache_key = (file, name.to_owned(), lane, depth);
        // CJS member fallback differs for `require` and an ES namespace's
        // `default` view, so only ES lookup enters the export cache.
        if root
            && !require
            && let Some(&value) = self.export_cache.get(&cache_key)
        {
            return value;
        }
        if self.export_stack.contains(&key) {
            return Err("export_cycle");
        }
        self.export_stack.push(key);
        let result = self.compute_export(file, name, lane, require, depth + 1);
        self.export_stack
            .pop()
            .expect("the export query on this stack");
        if root && !require && result != Err("resolution_depth_limit") {
            self.export_cache.insert(cache_key, result);
        }
        result
    }

    fn compute_export(
        &mut self,
        file: usize,
        name: &str,
        lane: Lane,
        require: bool,
        depth: usize,
    ) -> Lookup {
        let model = self.model(file);
        if let Some(entries) = model
            .exports
            .get(name)
            .filter(|entries| entries.iter().any(|&(_, only)| !only || lane == Lane::Type))
        {
            let entries = entries.clone();
            let mut chosen = None;
            let mut failure = "export_missing";
            for (entry, type_only) in entries {
                if type_only && lane == Lane::Value {
                    continue;
                }
                let value = match entry {
                    ExportEntry::Def(def) => self.export_definition(file, def, lane, depth + 1),
                    ExportEntry::Local(name) => self.name(file, NONE, name, lane, depth + 1),
                    ExportEntry::Value(value) => self.value_export(file, value, depth + 1),
                    ExportEntry::Reexport { import, name } => {
                        self.reexport(file, import, name, lane, depth + 1)
                    }
                };
                match value {
                    Ok(value) if chosen.is_some_and(|prior| prior != value) => {
                        return Err("ambiguous_export");
                    }
                    Ok(value) => chosen = Some(value),
                    Err(reason) => failure = reason,
                }
            }
            return chosen.ok_or(failure);
        }
        if let Some(export) = model.commonjs_members.get(name).copied() {
            return self.value_export(file, export, depth + 1);
        }
        if let Some(export) = model.commonjs {
            let value = self.value_export(file, export, depth + 1)?;
            if !require && name == "default" {
                return Ok(value);
            }
            if value != (Value::Module { file, require }) {
                let value = self.member(value, name, lane, depth + 1)?;
                if let Value::Member(member_file, index) = value
                    && self.model(member_file).facts.members[index].def == NONE
                {
                    return self.bound_value(value, depth + 1);
                }
                return Ok(value);
            }
        }
        // ES star exports never forward a default binding.
        if name == "default" {
            return Err("export_missing");
        }
        let stars = self.model(file).stars.clone();
        let mut winner = None;
        let mut failure = "export_missing";
        for (import, type_only) in stars {
            if type_only && lane == Lane::Value {
                continue;
            }
            match self.reexport(file, import, name, lane, depth + 1) {
                Ok(value) if winner.is_some_and(|prior| prior != value) => {
                    return Err("ambiguous_export");
                }
                Ok(value) => winner = Some(value),
                Err("export_missing" | "export_cycle" | "export_in_other_namespace") => {}
                Err(reason @ ("ambiguous_export" | "resolution_depth_limit")) => {
                    return Err(reason);
                }
                Err(reason) => failure = reason,
            }
        }
        // As in TypeScript, a star whose module can't be read contributes no
        // names, so a name the readable stars supply once still resolves. A
        // generated module missing from the checkout (for example TypeScript's
        // `diagnosticInformationMap.generated.ts`) would otherwise hide every
        // name of its barrel. Without a winner, the unreadable star's reason
        // explains the miss better than `export_missing`.
        winner.ok_or(failure)
    }

    fn reexport(
        &mut self,
        file: usize,
        import: usize,
        name: &str,
        lane: Lane,
        depth: usize,
    ) -> Lookup {
        let value = self.import(file, import)?;
        if name == "*" {
            Ok(value)
        } else {
            self.member(value, name, lane, depth + 1)
        }
    }

    fn value_export(&mut self, file: usize, export: &ExportValue, depth: usize) -> Lookup {
        self.eval(
            file,
            export.scope,
            export.value.ok_or("export_value_unknown")?,
            depth + 1,
        )
    }

    fn export_definition(&mut self, file: usize, def: i32, lane: Lane, depth: usize) -> Lookup {
        let target = def_ref(file, def).ok_or("export_missing")?;
        let definition = self.def(target);
        if lane == Lane::Type {
            if !matches!(
                definition.kind,
                Kind::Class
                    | Kind::Interface
                    | Kind::TypeAlias
                    | Kind::Namespace
                    | Kind::Module
                    | Kind::Enum
            ) {
                return Err("export_in_other_namespace");
            }
            Ok(Value::Def(target))
        } else {
            match definition.kind {
                Kind::Interface | Kind::TypeAlias => Err("export_in_other_namespace"),
                Kind::Variable | Kind::Constant => {
                    self.name(file, definition.scope, &definition.name, lane, depth + 1)
                }
                _ => Ok(Value::Def(target)),
            }
        }
    }
}
