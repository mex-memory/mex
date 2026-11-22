//! Shared reference rows and indexes for the syntax-only resolvers.

use std::cell::OnceCell;
use std::collections::{BTreeMap, HashMap, HashSet};

use mex_graph_core::facts::{
    Def, Import, Kind, ParseStatus, Range, ReferenceKind, SyntaxReference,
};

use mex_graph_core::resolve::Files;

use crate::EXCLUDED;

pub type DefRef = (usize, usize);
pub type Target = Result<DefRef, &'static str>;

#[derive(Clone, Copy)]
pub enum Site<'a> {
    Import(&'a Import),
    Symbol(&'a SyntaxReference),
}

impl<'a> Site<'a> {
    pub fn name(self) -> &'a str {
        match self {
            Self::Import(import) => &import.specifier,
            Self::Symbol(reference) => &reference.name,
        }
    }

    pub fn kind(self) -> &'static str {
        match self {
            Self::Import(_) => "imports",
            Self::Symbol(reference) => reference.kind.as_str(),
        }
    }

    pub fn range(self) -> Range {
        match self {
            Self::Import(import) => import.range,
            Self::Symbol(reference) => reference.range,
        }
    }
}

pub struct Edge<'a> {
    pub from: DefRef,
    pub to: DefRef,
    pub site: Site<'a>,
    pub method: &'static str,
}

pub struct Unresolved<'a> {
    pub from: DefRef,
    pub site: Site<'a>,
    pub reason: &'static str,
}

pub struct ImportTarget<'a> {
    pub import: &'a Import,
    pub module: Option<usize>,
    pub target: Option<DefRef>,
}

#[derive(Default)]
pub struct FileResolution<'a> {
    pub edges: Vec<Edge<'a>>,
    pub unresolved: Vec<Unresolved<'a>>,
    pub imports: Vec<ImportTarget<'a>>,
    seen: HashSet<(usize, DefRef, &'static str, u32, u32)>,
}

impl<'a> FileResolution<'a> {
    pub fn push(&mut self, from: DefRef, site: Site<'a>, target: Target, method: &'static str) {
        match target {
            Ok(to) => {
                let range = site.range();
                if self
                    .seen
                    .insert((from.1, to, site.kind(), range.start_line, range.start_col))
                {
                    self.edges.push(Edge {
                        from,
                        to,
                        site,
                        method,
                    });
                }
            }
            Err(reason) => self.unresolved.push(Unresolved { from, site, reason }),
        }
    }
}

pub fn unresolved_counts(files: &[FileResolution<'_>]) -> Vec<(usize, &'static str, u32)> {
    files
        .iter()
        .enumerate()
        .flat_map(|(file, rows)| {
            let mut reasons = BTreeMap::new();
            for reference in &rows.unresolved {
                *reasons.entry(reference.reason).or_insert(0) += 1;
            }
            reasons
                .into_iter()
                .map(move |(reason, count)| (file, reason, count))
        })
        .collect()
}

type Children = HashMap<usize, Vec<DefRef>>;

pub struct Index<'a> {
    pub facts: Files<'a>,
    paths: HashMap<&'a str, usize>,
    children: Vec<OnceCell<Children>>,
}

impl<'a> Index<'a> {
    pub fn new(facts: Files<'a>) -> Self {
        Self {
            facts,
            paths: facts
                .paths()
                .enumerate()
                .map(|(i, path)| (path, i))
                .collect(),
            children: (0..facts.len()).map(|_| OnceCell::new()).collect(),
        }
    }

    pub fn file(&self, path: &str) -> Option<usize> {
        self.facts.lookup("path", path);
        self.paths.get(path).copied().filter(|&index| {
            let facts = self.facts.get(index);
            facts.health.status != ParseStatus::Failed && !facts.defs.is_empty()
        })
    }

    pub fn def(&self, (file, def): DefRef) -> &'a Def {
        &self.facts.get(file).defs[def]
    }

    pub fn parent(&self, id: DefRef) -> Option<DefRef> {
        let parent = (id.0, usize::try_from(self.def(id).parent).ok()?);
        visible(self.def(parent)).then_some(parent)
    }

    pub fn children(&self, (file, def): DefRef) -> &[DefRef] {
        let facts = self.facts.get(file);
        self.children[file]
            .get_or_init(|| {
                let mut children = HashMap::<_, Vec<_>>::new();
                for (child, node) in facts.defs.iter().enumerate().skip(1) {
                    if visible(node)
                        && let Some((_, parent)) = self.parent((file, child))
                    {
                        children.entry(parent).or_default().push((file, child));
                    }
                }
                children
            })
            .get(&def)
            .map_or(&[], Vec::as_slice)
    }

    pub fn ancestors(&self, id: DefRef) -> impl Iterator<Item = DefRef> {
        std::iter::successors(self.parent(id), |&parent| self.parent(parent))
    }
}

pub fn visible(def: &Def) -> bool {
    !def.flags.iter().any(|flag| flag == EXCLUDED)
}

pub fn unique(mut candidates: impl Iterator<Item = DefRef>) -> Target {
    let Some(candidate) = candidates.next() else {
        return Err("no_visible_declaration");
    };
    if candidates.next().is_some() {
        return Err("ambiguous_target");
    }
    Ok(candidate)
}

pub fn last_segment(name: &str) -> &str {
    name.rsplit('.')
        .next()
        .unwrap_or(name)
        .rsplit("::")
        .next()
        .unwrap_or(name)
}

pub fn accepts(kind: ReferenceKind, def: &Def) -> bool {
    match kind {
        ReferenceKind::Calls => matches!(def.kind, Kind::Function | Kind::Method),
        ReferenceKind::Extends | ReferenceKind::Implements => {
            matches!(def.kind, Kind::Class | Kind::Interface)
        }
        ReferenceKind::Instantiates => def.kind == Kind::Class,
        _ => true,
    }
}
