//! Contextual `this` in object literals passed to explicitly specialized
//! functions. Only a readable `ThisType<T>` marker (possibly through a type
//! alias) contributes evidence; an ordinary object parameter supplies none.

use std::collections::HashMap;

use mex_graph_core::facts::Kind;
use mex_graph_core::facts::ecmascript::Expression;

use super::{Lane, Lookup, Resolver, Site, Value, check_depth};

type Substitutions<'a> = HashMap<&'a str, Option<Value>>;

impl<'a> Resolver<'a> {
    pub(super) fn index_contextual_this(&mut self) {
        for file in 0..self.files.len() {
            let Some(model) = &self.index[file] else {
                continue;
            };
            for contextual in &model.facts.contextual_calls {
                let call = &self.files[file].calls[contextual.call];
                let Ok((target_file, target_def)) = self.resolve_call(file, call) else {
                    continue;
                };
                let parameters = &self.def((target_file, target_def)).type_parameters;
                let mut substitutes = HashMap::new();
                for (name, expression) in parameters.iter().zip(&contextual.types) {
                    let value = expression.and_then(|id| self.eval(file, call.scope, id, 0).ok());
                    substitutes.insert(name.as_str(), value);
                }
                for &(position, object) in &contextual.objects {
                    let Some(formals) = self
                        .model(target_file)
                        .formal_types
                        .get(&(target_def as i32, position))
                        .cloned()
                    else {
                        continue;
                    };
                    let mut known = None;
                    for formal in &formals {
                        let site = Site {
                            file: target_file,
                            scope: formal.scope,
                            expression: formal.expression,
                        };
                        match self.this_type(site, &substitutes, 0) {
                            Ok(value) if known.is_none_or(|prior| prior == value) => {
                                known = Some(value)
                            }
                            _ => {
                                known = None;
                                break;
                            }
                        }
                    }
                    if let Some(value) = known {
                        self.contextual_this.insert((file, object), value);
                    }
                }
            }
        }
        self.export_cache.clear();
    }

    pub(super) fn type_symbol(
        &mut self,
        file: usize,
        scope: i32,
        name: &str,
        depth: usize,
    ) -> Lookup {
        let mut parts = name.split('.');
        let head = self.name(
            file,
            scope,
            parts.next().ok_or("type_unknown")?,
            Lane::Type,
            depth + 1,
        )?;
        parts.try_fold(head, |value, part| {
            self.member(value, part, Lane::Type, depth + 1)
        })
    }

    fn this_type(&mut self, site: Site, substitutes: &Substitutions<'a>, depth: usize) -> Lookup {
        check_depth(depth)?;
        let (file, scope) = (site.file, site.scope);
        let (name, args) = match self.model(file).expression(site.expression) {
            Expression::GenericType { name, arguments } => (name, arguments.as_slice()),
            Expression::TypeName { name } => (name, &[][..]),
            Expression::Intersection { parts } => {
                let mut found = None;
                for &expression in parts {
                    if let Ok(value) =
                        self.this_type(Site { expression, ..site }, substitutes, depth + 1)
                    {
                        if found.is_some_and(|prior| prior != value) {
                            return Err("ambiguous_this_type");
                        }
                        found = Some(value);
                    }
                }
                return found.ok_or("contextual_this_unknown");
            }
            _ => return Err("contextual_this_unknown"),
        };
        let symbol = self.type_symbol(file, scope, name, depth + 1);
        if name == "ThisType"
            && symbol == Err("unknown_binding")
            && let [Some(expression)] = args
        {
            return self.substitute_type(
                Site {
                    expression: *expression,
                    ..site
                },
                substitutes,
                depth + 1,
            );
        }
        let (alias_file, alias_def) = self.referenced(symbol?).ok_or("contextual_this_unknown")?;
        let definition = self.def((alias_file, alias_def));
        if definition.kind != Kind::TypeAlias {
            return Err("contextual_this_unknown");
        }
        let mut parameters = HashMap::new();
        for (parameter, argument) in definition.type_parameters.iter().zip(args) {
            parameters.insert(
                parameter.as_str(),
                argument.and_then(|expression| {
                    self.substitute_type(Site { expression, ..site }, substitutes, depth + 1)
                        .ok()
                }),
            );
        }
        let alias = self
            .model(alias_file)
            .aliases
            .get(&alias_def)
            .ok_or("contextual_this_unknown")?;
        self.this_type(
            Site {
                file: alias_file,
                scope: alias.scope,
                expression: alias.value,
            },
            &parameters,
            depth + 1,
        )
    }

    fn substitute_type(
        &mut self,
        site: Site,
        substitutes: &Substitutions<'a>,
        depth: usize,
    ) -> Lookup {
        if let Expression::TypeName { name } = self.model(site.file).expression(site.expression)
            && let Some(value) = substitutes.get(name.as_str())
        {
            return value.ok_or("type_argument_unknown");
        }
        self.eval(site.file, site.scope, site.expression, depth + 1)
    }
}
