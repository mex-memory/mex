use mex_graph_core::facts::ecmascript::{ExprId, Expression};
use tree_sitter::Node;

use super::Collector;
use crate::nodes::documentation::{tag_annotation, tags};
use crate::nodes::syntax::{field, initializer};

impl<'a> Collector<'a, '_> {
    pub(super) fn javascript(&self) -> bool {
        matches!(self.facts.language.as_str(), "javascript" | "jsx")
    }

    pub(super) fn jsdoc_annotation(
        &self,
        mut node: Node<'a>,
        wanted: &str,
        name: Option<&str>,
    ) -> Option<&'a str> {
        if !self.javascript() {
            return None;
        }
        loop {
            if let Some((_, comment)) = self.source.docs_at(self.source.start_of(node), false)
                && let Some(annotation) = tags(comment)
                    .filter(|&(_, tag, _)| {
                        tag == wanted || wanted == "param" && matches!(tag, "arg" | "argument")
                    })
                    .filter_map(|(_, _, body)| tag_annotation(body))
                    .find_map(|(ty, rest)| {
                        let argument = rest.split_whitespace().next().unwrap_or("");
                        let argument = argument
                            .trim_start_matches('[')
                            .split(['=', ']'])
                            .next()
                            .unwrap_or("");
                        name.is_none_or(|name| name == argument).then_some(ty)
                    })
            {
                return Some(annotation);
            }
            let parent = self.source.parent(node)?;
            if initializer(parent) != Some(node)
                && field(parent, "right") != Some(node)
                && !matches!(
                    parent.kind(),
                    "lexical_declaration"
                        | "variable_declaration"
                        | "export_statement"
                        | "expression_statement"
                )
            {
                return None;
            }
            node = parent;
        }
    }

    pub(super) fn jsdoc_type(&mut self, annotation: &str, depth: usize) -> Option<ExprId> {
        if depth == 8 {
            return None;
        }
        let annotation = annotation.trim().trim_start_matches(['?', '!']);
        let value = if let Some(item) = annotation.strip_suffix("[]") {
            Expression::Array {
                element: self.jsdoc_type(item, depth + 1),
            }
        } else if let Some(item) = annotation
            .strip_prefix("Promise<")
            .and_then(|p| p.strip_suffix('>'))
        {
            Expression::Promise {
                element: self.jsdoc_type(item, depth + 1)?,
            }
        } else if annotation.split('.').all(identifier) {
            Expression::TypeName {
                name: annotation.into(),
            }
        } else {
            return None;
        };
        self.push_expression(value)
    }
}

fn identifier(value: &str) -> bool {
    let mut chars = value.chars();
    chars
        .next()
        .is_some_and(|c| c.is_alphabetic() || matches!(c, '$' | '_'))
        && chars.all(|c| c.is_alphanumeric() || matches!(c, '$' | '_'))
}
