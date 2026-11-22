//! Plan and write one v5 resolution delta. The source publication owns its
//! facts. Resolution reads and callback inputs are owned by their site.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::rc::Rc;

use mex_graph_core::facts::{FileFacts, ParseStatus};
use mex_graph_core::resolve::{Access, Files};
use mex_graph_core::store::{BaseFile, RefreshBase, Writer};
use mex_graph_core::timing::Timer;
use mex_graph_ecmascript::modules::{ModuleResolver, Syntax};
use mex_graph_ecmascript::resolve::DefRef;

use super::{Identities, build, ecmascript, edit_facts, node_ids, python_file, relations, syntax};
use crate::frameworks::{DETECTION, Enabled};
use crate::job::{ConfigSource, JobError, Request, RequestFile, request_language};
use crate::syntax_language::SyntaxLanguage;

pub(super) struct PublishedOverlay {
    pub(super) path: PathBuf,
    pub(super) db: RefreshBase,
    pub(super) files: HashMap<String, BaseFile>,
    pub(super) shadows: Vec<String>,
    shadowed: HashSet<String>,
}

impl PublishedOverlay {
    pub(super) fn open(path: PathBuf, base: &Path) -> Result<Self, JobError> {
        if !path.is_absolute()
            || path.parent() != base.parent()
            || !std::fs::symlink_metadata(&path).is_ok_and(|entry| entry.is_file())
        {
            return Err(JobError::request(
                "The published overlay must be a regular sibling of the base",
            ));
        }
        let db = RefreshBase::open_overlay(&path, base).map_err(JobError::write)?;
        let files = db.files().map_err(JobError::write)?;
        let shadows = db.shadows().map_err(JobError::write)?;
        let shadowed = shadows.iter().cloned().collect();
        Ok(Self {
            path,
            db,
            files,
            shadows,
            shadowed,
        })
    }
}

pub(super) struct Publication<'a> {
    pub(super) base: &'a RefreshBase,
    pub(super) base_files: &'a HashMap<String, BaseFile>,
    pub(super) overlay: Option<&'a PublishedOverlay>,
}

impl Publication<'_> {
    pub(super) fn file(&self, path: &str) -> Option<(&BaseFile, bool)> {
        if let Some(overlay) = self
            .overlay
            .filter(|overlay| overlay.shadowed.contains(path))
        {
            overlay.files.get(path).map(|file| (file, true))
        } else {
            self.base_files.get(path).map(|file| (file, false))
        }
    }

    pub(super) fn paths(&self) -> impl Iterator<Item = &str> + Clone {
        self.base_files
            .keys()
            .filter(|path| {
                self.overlay
                    .is_none_or(|overlay| !overlay.shadowed.contains(*path))
            })
            .chain(
                self.overlay
                    .into_iter()
                    .flat_map(|overlay| overlay.files.keys()),
            )
            .map(String::as_str)
    }

    pub(super) fn current(&self) -> &RefreshBase {
        self.overlay.map_or(self.base, |overlay| &overlay.db)
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Language {
    Python,
    Ecma,
    Rust,
    CSharp,
}

impl Language {
    const ALL: [Self; 4] = [Self::Python, Self::Ecma, Self::Rust, Self::CSharp];

    fn get(path: &str, languages: &[String]) -> Option<Self> {
        match request_language(path, languages)? {
            "python" => Some(Self::Python),
            "rust" => Some(Self::Rust),
            "csharp" => Some(Self::CSharp),
            _ => Some(Self::Ecma),
        }
    }
}

pub(super) fn project_modules<'a>(
    root: &Path,
    request: &'a Request,
    configs: &'a [ConfigSource<'a>],
) -> ModuleResolver {
    modules(
        root,
        request
            .files
            .iter()
            .filter(|file| Language::get(&file.path, &request.languages) == Some(Language::Ecma))
            .map(|file| file.path.as_str()),
        configs,
    )
}

pub(super) fn modules<'a>(
    root: &Path,
    paths: impl IntoIterator<Item = &'a str>,
    configs: &'a [ConfigSource<'a>],
) -> ModuleResolver {
    let configs = configs.iter().map(|(path, text)| (*path, text.as_ref()));
    match root.to_str().filter(|path| path.starts_with('/')) {
        Some(root) => ModuleResolver::with_repository_root(root, paths, configs),
        None => ModuleResolver::new(paths, configs),
    }
}

#[derive(Clone, Copy, Hash, PartialEq, Eq)]
enum Read {
    File(usize),
    Import(usize, usize),
    Lookup(usize),
}

#[derive(Default)]
struct Reads {
    items: HashSet<Read>,
    memos: HashSet<usize>,
}

#[derive(Default)]
struct Lookups {
    ids: HashMap<&'static str, HashMap<Rc<str>, usize>>,
    keys: Vec<(&'static str, Rc<str>)>,
}

impl Lookups {
    fn intern(&mut self, kind: &'static str, key: &str) -> usize {
        let ids = self.ids.entry(kind).or_default();
        if let Some(&id) = ids.get(key) {
            return id;
        }
        let id = self.keys.len();
        let key: Rc<str> = key.into();
        ids.insert(key.clone(), id);
        self.keys.push((kind, key));
        id
    }
}

struct Recorder {
    reads: Vec<RefCell<Reads>>,
    lookups: RefCell<Lookups>,
    origin: Cell<Option<usize>>,
    nested: RefCell<Vec<usize>>,
    active_memo: Cell<Option<usize>>,
    memos: RefCell<Vec<HashSet<Read>>>,
    last_file: Cell<Option<usize>>,
}

impl Recorder {
    fn new(files: usize) -> Self {
        Self {
            reads: (0..files).map(|_| RefCell::new(Reads::default())).collect(),
            lookups: RefCell::default(),
            origin: Cell::new(None),
            nested: RefCell::default(),
            active_memo: Cell::new(None),
            memos: RefCell::default(),
            last_file: Cell::new(None),
        }
    }

    fn stop(&self) {
        self.origin.set(None);
        self.last_file.set(None);
    }

    fn observe(&self, access: Access<'_>) {
        let previous_file = self.last_file.take();
        let item = match access {
            Access::Origin(origin) => return self.origin.set(Some(origin)),
            Access::Enter(origin) => return self.nested.borrow_mut().push(origin),
            Access::Leave => {
                self.nested.borrow_mut().pop();
                return;
            }
            Access::StartMemo(id) => {
                debug_assert!(self.active_memo.get().is_none());
                self.active_memo.set(Some(id));
                let mut memos = self.memos.borrow_mut();
                debug_assert_eq!(id, memos.len());
                memos.push(HashSet::new());
                return;
            }
            Access::EndMemo => return self.active_memo.set(None),
            Access::ReadMemo(id) => {
                let memo = &self.memos.borrow()[id];
                self.record_to_origins(|_, reads| {
                    if reads.memos.insert(id) {
                        reads.items.extend(memo.iter().copied());
                    }
                });
                return;
            }
            Access::File(file) => {
                self.last_file.set(Some(file));
                if self.origin.get().is_none() || previous_file == Some(file) {
                    return;
                }
                Read::File(file)
            }
            Access::Import(file, index) => Read::Import(file, index),
            Access::Lookup(kind, key) => Read::Lookup(self.lookups.borrow_mut().intern(kind, key)),
        };
        self.record_to_origins(|origin, reads| {
            if item != Read::File(origin) {
                reads.items.insert(item);
            }
        });
        if let Some(id) = self.active_memo.get() {
            self.memos.borrow_mut()[id].insert(item);
        }
    }

    fn record_to_origins(&self, mut update: impl FnMut(usize, &mut Reads)) {
        if let Some(origin) = self.origin.get() {
            update(origin, &mut self.reads[origin].borrow_mut());
            for &file in self.nested.borrow().iter().filter(|&&file| file != origin) {
                update(file, &mut self.reads[file].borrow_mut());
            }
        }
    }

    fn write<'a>(
        &self,
        writer: &Writer,
        origins: &[usize],
        paths: &[&str],
        load: impl Fn(usize) -> &'a FileFacts,
    ) -> Result<(), JobError> {
        let _timer = Timer::start("resolve.dependencies");
        let lookups = self.lookups.borrow();
        let reads: Vec<_> = self.reads.iter().map(RefCell::borrow).collect();
        let mut imports = HashMap::new();
        for &origin in origins {
            for &item in &reads[origin].items {
                if let Read::Import(file, index) = item {
                    imports.entry((file, index)).or_insert_with(|| {
                        let import = &load(file).imports[index];
                        let kind = match import.form {
                            mex_graph_core::facts::ImportForm::CommonJs => "ts-require",
                            _ => "ts-import",
                        };
                        (kind, format!("{}\0{}", paths[file], import.specifier))
                    });
                }
            }
        }
        let mut rows = Vec::new();
        for &origin in origins {
            for &item in &reads[origin].items {
                let (kind, key) = match item {
                    Read::File(file) if file == origin => continue,
                    Read::File(file) => ("file", paths[file]),
                    Read::Import(file, index) => {
                        let (kind, key) = &imports[&(file, index)];
                        (*kind, key.as_str())
                    }
                    Read::Lookup(id) => {
                        let (kind, key) = &lookups.keys[id];
                        (*kind, key.as_ref())
                    }
                };
                rows.push((kind, key, paths[origin]));
            }
        }
        rows.sort_unstable();
        rows.dedup();
        for (kind, key, origin) in rows {
            writer
                .put_read(origin, kind, key)
                .map_err(JobError::write)?;
        }
        Ok(())
    }
}

/// Inputs already match the complete source observation, in request order.
/// When loading lazily, callers capture I/O errors and abandon the candidate.
pub(super) struct Corpus<'a> {
    pub(super) root: &'a Path,
    pub(super) request: &'a Request,
    pub(super) configs: &'a [ConfigSource<'a>],
    pub(super) sizes: &'a HashMap<&'a str, u64>,
    pub(super) load: &'a dyn Fn(&str) -> &'a FileFacts,
    pub(super) modules: Option<&'a ModuleResolver>,
}

impl Corpus<'_> {
    /// Installs per-origin results before emitting any public row. This keeps
    /// cross-file callback ownership independent of traversal and write order.
    pub(super) fn resolve(
        &self,
        writer: &Writer,
        enabled: &Enabled,
        selected: &HashSet<&str>,
        removed: &HashSet<&str>,
        overlay: bool,
    ) -> Result<(), JobError> {
        let _timer = Timer::start("resolve.incremental");
        for language in Language::ALL {
            let paths: Vec<_> = self
                .request
                .files
                .iter()
                .filter(|file| {
                    self.sizes.contains_key(file.path.as_str())
                        && Language::get(&file.path, &self.request.languages) == Some(language)
                })
                .map(|file| file.path.as_str())
                .collect();
            let origins: Vec<_> = paths
                .iter()
                .enumerate()
                .filter_map(|(i, path)| selected.contains(path).then_some(i))
                .collect();
            if origins.is_empty() {
                continue;
            }
            let recorder = Recorder::new(paths.len());
            let loaded: Vec<_> = (0..paths.len())
                .map(|_| std::cell::OnceCell::new())
                .collect();
            let load = |file: usize| *loaded[file].get_or_init(|| (self.load)(paths[file]));
            let observe = |access: Access<'_>| recorder.observe(access);
            let facts = Files::Lazy {
                paths: &paths,
                load: &load,
                observe: &observe,
            };
            let project = |index, file: super::StagedFile<'_>| -> Result<(), JobError> {
                let facts = load(index);
                relations::Projection::new(&file, facts)?.install(writer, &facts.path)?;
                if has_heritage(facts) {
                    writer
                        .put_read(&facts.path, "ts-heritage", "")
                        .map_err(JobError::write)?;
                }
                for marker in &facts.frameworks {
                    if marker.kind == DETECTION {
                        writer
                            .put_read(&facts.path, DETECTION, &marker.name)
                            .map_err(JobError::write)?;
                    }
                }
                Ok(())
            };
            match language {
                Language::Ecma => {
                    let temporary;
                    let modules = if let Some(modules) = self.modules {
                        modules
                    } else {
                        temporary = modules(self.root, paths.iter().copied(), self.configs);
                        &temporary
                    };
                    let paths_by_index: HashMap<_, _> =
                        paths.iter().enumerate().map(|(i, &p)| (p, i)).collect();
                    let error = RefCell::new(None);
                    let descendants = |(file, def)| {
                        if !overlay {
                            return Vec::new();
                        }
                        match writer.prior_descendants(paths[file], def) {
                            Ok(rows) => rows
                                .into_iter()
                                .filter_map(|(path, from)| {
                                    if selected.contains(path.as_str())
                                        || removed.contains(path.as_str())
                                    {
                                        return None;
                                    }
                                    let &index = paths_by_index.get(path.as_str())?;
                                    (load(index).defs.get(from).is_some()).then_some((index, from))
                                })
                                .collect(),
                            Err(problem) => {
                                *error.borrow_mut() = Some(problem);
                                Vec::new()
                            }
                        }
                    };
                    let timer = Timer::start("resolve.ecmascript");
                    let (stage, heritage) = ecmascript::Stage::resolve(
                        facts,
                        modules,
                        Some(enabled),
                        &origins,
                        descendants,
                        true,
                    );
                    drop(timer);
                    if let Some(error) = error.into_inner() {
                        return Err(JobError::write(error));
                    }
                    recorder.stop();
                    for ((origin, from), (target, def)) in heritage {
                        writer
                            .put_heritage(paths[target], def, paths[origin], from)
                            .map_err(JobError::write)?;
                    }
                    for &index in &origins {
                        project(index, stage.file(index, self.sizes[paths[index]], false))?;
                    }
                }
                Language::Python => {
                    let resolver = mex_graph_python::resolve::Resolver::with_files(facts);
                    let ids = Identities::new(facts);
                    for &index in &origins {
                        let mut out = mex_graph_python::resolve::Resolution::default();
                        resolver.resolve_file(index, &mut out);
                        recorder.stop();
                        let links = enabled.file_links(index, load(index), &[]);
                        project(
                            index,
                            python_file(
                                facts,
                                &ids,
                                index,
                                self.sizes[paths[index]],
                                false,
                                &out.edges,
                                &out.unresolved_calls,
                                &out.call_candidates,
                                Some(&links),
                            ),
                        )?;
                    }
                }
                Language::Rust | Language::CSharp => {
                    let mut results: Vec<_> =
                        (0..paths.len()).map(|_| Default::default()).collect();
                    let adapter = if language == Language::Rust {
                        let resolver = mex_graph_rust::resolve::Resolver::new(facts);
                        for &index in &origins {
                            results[index] = resolver.resolve_file(index);
                        }
                        SyntaxLanguage::Rust
                    } else {
                        let mut changed_types: HashMap<&str, Vec<DefRef>> = HashMap::new();
                        for &index in &origins {
                            for (name, def) in types(load(index)) {
                                changed_types.entry(name).or_default().push((index, def));
                                writer
                                    .put_type(name, paths[index], def)
                                    .map_err(JobError::write)?;
                            }
                        }
                        let by_path: HashMap<_, _> =
                            paths.iter().enumerate().map(|(i, &p)| (p, i)).collect();
                        let cache = RefCell::new(HashMap::<String, Vec<DefRef>>::new());
                        let error = RefCell::new(None);
                        let lookup = |name: &str| {
                            let mut cache = cache.borrow_mut();
                            if let Some(ids) = cache.get(name) {
                                return ids.clone();
                            }
                            let mut ids = changed_types.get(name).cloned().unwrap_or_default();
                            if overlay {
                                match writer.prior_types(name) {
                                    Ok(rows) => {
                                        ids.extend(rows.into_iter().filter_map(|(path, def)| {
                                            if selected.contains(path.as_str()) {
                                                return None;
                                            }
                                            let &i = by_path.get(path.as_str())?;
                                            load(i).defs.get(def).map(|_| (i, def))
                                        }))
                                    }
                                    Err(problem) => {
                                        *error.borrow_mut() = Some(problem);
                                    }
                                }
                            }
                            cache.insert(name.into(), ids.clone());
                            ids
                        };
                        let resolver = mex_graph_csharp::resolve::Resolver::new(facts, &lookup);
                        for &index in &origins {
                            results[index] = resolver.resolve_file(index);
                        }
                        if let Some(error) = error.into_inner() {
                            return Err(JobError::write(error));
                        }
                        SyntaxLanguage::CSharp
                    };
                    recorder.stop();
                    let stage = syntax::Stage::resolved(facts, adapter, results);
                    for &index in &origins {
                        project(index, stage.file(index, self.sizes[paths[index]], false))?;
                    }
                }
            }
            recorder.write(writer, &origins, &paths, load)?;
        }
        Ok(())
    }
}

fn has_heritage(facts: &FileFacts) -> bool {
    facts
        .ecmascript
        .as_ref()
        .is_some_and(|extra| !extra.bases.is_empty())
}

fn types(facts: &FileFacts) -> impl Iterator<Item = (&str, usize)> {
    facts.defs.iter().enumerate().filter_map(|(index, def)| {
        (facts.health.status != ParseStatus::Failed
            && mex_graph_csharp::resolve::is_type(def.kind)
            && mex_graph_syntax::resolve::visible(def))
        .then_some((def.name.as_str(), index))
    })
}

pub(super) struct Plan<'a> {
    pub(super) edited: HashSet<&'a str>,
    removed: HashSet<&'a str>,
    resolve: HashSet<&'a str>,
    copy_outgoing: HashSet<&'a str>,
}

impl<'a> Plan<'a> {
    pub(super) fn new(
        corpus: &Corpus<'a>,
        prior: &'a Publication<'a>,
        writer: &Writer,
        complete: bool,
        edits: impl IntoIterator<Item = &'a RequestFile>,
    ) -> Result<Self, JobError> {
        let _timer = Timer::start("incremental.plan");
        let current = corpus.sizes;
        let removed: HashSet<_> = prior
            .paths()
            .filter(|path| !current.contains_key(path))
            .collect();
        let mut edited = HashSet::new();
        let mut surfaces = Vec::new();
        let mut reusable = HashMap::new();
        for file in edits {
            let path = file.path.as_str();
            if !current.contains_key(path) {
                continue;
            }
            let Some((old, _)) = prior.file(path) else {
                edited.insert(path);
                surfaces.push(path);
                continue;
            };
            let current_hash = file
                .content_hash
                .as_deref()
                .and_then(crate::job::decode_hash);
            if (current_hash != Some(old.hash)
                && (current_hash.is_some() || (corpus.load)(path).content_hash != old.hash))
                || old.extractor_version != file.extractor_version.as_deref().unwrap_or("mex-graph")
                || old.size != corpus.sizes[path]
            {
                edited.insert(path);
                if complete {
                    continue;
                }
                let Some(blob) = writer.prior_projection(path).map_err(JobError::write)? else {
                    surfaces.push(path);
                    continue;
                };
                let rows: relations::Projection = relations::decode(&blob)?;
                let signature = edit_facts::Signature::new((corpus.load)(path))?;
                if let Some(sites) = rows.signature.positions(&signature) {
                    reusable.insert(path, (rows, signature, sites));
                } else if !rows.signature.same_surface(&signature) {
                    surfaces.push(path);
                }
            }
        }
        let mut resolve = edited.clone();
        let mut affected = HashSet::new();
        let mut copy_outgoing = HashSet::new();
        if complete {
            resolve = current.keys().copied().collect();
        } else {
            let mut frontier: VecDeque<_> = surfaces
                .iter()
                .copied()
                .chain(removed.iter().copied())
                .map(str::to_owned)
                .collect();
            let mut ts_dispatch = false;
            let mut csharp_types = BTreeSet::new();
            for path in surfaces.iter().copied().chain(removed.iter().copied()) {
                match Language::get(path, &corpus.request.languages) {
                    Some(Language::Ecma) => ts_dispatch = true,
                    Some(Language::CSharp) => {
                        csharp_types.extend(writer.prior_types_in(path).map_err(JobError::write)?);
                        if current.contains_key(path) {
                            csharp_types.extend(
                                types((corpus.load)(path)).map(|(name, _)| name.to_owned()),
                            );
                        }
                    }
                    _ => {}
                }
            }
            for name in csharp_types {
                frontier.extend(
                    writer
                        .readers("csharp-type", &name)
                        .map_err(JobError::write)?,
                );
            }
            let topology =
                !removed.is_empty() || edited.iter().any(|path| prior.file(path).is_none());
            if topology {
                for path in removed.iter().copied().chain(
                    edited
                        .iter()
                        .copied()
                        .filter(|path| prior.file(path).is_none()),
                ) {
                    frontier.extend(writer.readers("path", path).map_err(JobError::write)?);
                    if let Some(crate_path) = path.strip_suffix("/src/lib.rs") {
                        let name = crate_path
                            .rsplit('/')
                            .next()
                            .unwrap_or(crate_path)
                            .replace('-', "_");
                        frontier.extend(
                            writer
                                .readers("rust-crate", &name)
                                .map_err(JobError::write)?,
                        );
                    }
                }
                ts_dispatch |= topology_readers(corpus, prior, writer, &mut frontier)?;
            }
            let mut visited = HashSet::new();
            while let Some(path) = frontier.pop_front() {
                if !visited.insert(path.clone()) {
                    continue;
                }
                if let Some((&path, _)) = current.get_key_value(path.as_str()) {
                    resolve.insert(path);
                    affected.insert(path);
                }
                frontier.extend(writer.readers("file", &path).map_err(JobError::write)?);
            }
            if ts_dispatch {
                let new_heritage = surfaces
                    .iter()
                    .any(|path| has_heritage((corpus.load)(path)));
                let old_heritage = writer.readers("ts-heritage", "").map_err(JobError::write)?;
                if new_heritage || old_heritage.iter().any(|path| visited.contains(path)) {
                    // Candidate hints are output rows. A caller of a hint's
                    // owner does not depend on that owner's hint.
                    for path in writer.readers("ts-dispatch", "").map_err(JobError::write)? {
                        if let Some((&path, _)) = current.get_key_value(path.as_str()) {
                            resolve.insert(path);
                            affected.insert(path);
                        }
                    }
                }
            }
            for (path, (mut rows, signature, positions)) in reusable {
                if affected.contains(path) {
                    continue;
                }
                let facts = (corpus.load)(path);
                if rows.unchanged_sites(facts, &positions)? {
                    copy_outgoing.insert(path);
                    resolve.remove(path);
                } else if rows.rebase(facts, &positions)? {
                    rows.signature = signature;
                    rows.install(writer, path)?;
                    writer.carry_origin_index(path).map_err(JobError::write)?;
                    resolve.remove(path);
                }
            }
        }
        Ok(Self {
            edited,
            removed,
            resolve,
            copy_outgoing,
        })
    }

    pub(super) fn resolution_count(&self) -> usize {
        self.resolve.len()
    }

    pub(super) fn write(
        self,
        corpus: &Corpus<'_>,
        writer: &mut Writer,
        enabled: &Enabled,
        prior: &Publication<'_>,
    ) -> Result<(), JobError> {
        for path in &self.removed {
            if prior.base_files.contains_key(*path) {
                writer.shadow(path).map_err(JobError::write)?;
            }
            writer.put_projection(path, None).map_err(JobError::write)?;
        }
        if !self.resolve.is_empty() {
            corpus.resolve(writer, enabled, &self.resolve, &self.removed, true)?;
        }
        let _timer = Timer::start("project.incremental");
        let rewrite: Vec<_> = self.edited.union(&self.resolve).copied().collect();
        let mut callbacks = HashSet::new();
        for path in rewrite
            .iter()
            .filter(|path| !self.copy_outgoing.contains(*path))
            .chain(self.removed.iter())
        {
            callbacks.extend(
                writer
                    .prior_callback_owners(path)
                    .map_err(JobError::write)?,
            );
            callbacks.extend(writer.callback_owners(path).map_err(JobError::write)?);
        }
        let owners: HashSet<_> = rewrite
            .iter()
            .copied()
            .chain(callbacks.iter().map(String::as_str))
            .collect();
        let files = FileKeys::new(&self.edited, prior);
        let mut keys = NodeKeys::new(writer, prior)?;
        let by_path: HashMap<_, _> = corpus
            .request
            .files
            .iter()
            .map(|file| (file.path.as_str(), file))
            .collect();
        // Allocate changed declarations before writing any cross-file edge.
        for &path in &self.edited {
            let facts = (corpus.load)(path);
            let ids = node_ids(facts);
            keys.register(&ids)?;
            writer.shadow(path).map_err(JobError::write)?;
            build::write_file(
                writer,
                corpus.root,
                corpus.request,
                by_path[path],
                facts,
                corpus.sizes[path],
                &ids,
                &keys.borrowed(&ids),
                Some(files.get(path)),
            )?;
        }
        let mut written: HashSet<String> = self
            .edited
            .iter()
            .chain(&self.removed)
            .map(|&path| path.to_owned())
            .collect();
        for path in owners {
            if !corpus.sizes.contains_key(path) {
                continue;
            }
            let key = files.get(path);
            if self.copy_outgoing.contains(path) && !callbacks.contains(path) {
                let (old, previous) = prior.file(path).expect("reused origin is published");
                writer
                    .copy_outgoing_from(old.key, previous)
                    .map_err(JobError::write)?;
                writer
                    .set_file_resolution(key, &old.resolution)
                    .map_err(JobError::write)?;
                continue;
            }
            let blob = writer
                .projection(path)
                .map_err(JobError::write)?
                .map_or_else(
                    || writer.prior_projection(path).map_err(JobError::write),
                    |blob| Ok(Some(blob)),
                )?
                .ok_or_else(|| JobError::request(format!("Missing resolution for {path}")))?;
            let rows = relations::Outgoing::load(writer, path, relations::decode(&blob)?)?;
            let digest = rows.digest()?;
            if !self.edited.contains(path) {
                let (file, previous) = prior.file(path).expect("new paths are edited");
                if file.resolution == digest {
                    continue;
                }
                writer.shadow(path).map_err(JobError::write)?;
                writer
                    .copy_declarations(key, previous)
                    .map_err(JobError::write)?;
                build::index_source(
                    writer,
                    corpus.root,
                    corpus.request,
                    by_path[path],
                    &file.hash,
                    key,
                )?;
                written.insert(path.into());
            }
            rows.write(writer, |site| files.get(site), |id| keys.existing(id))?;
            writer
                .set_file_resolution(key, &digest)
                .map_err(JobError::write)?;
        }
        // The next overlay is still relative to the canonical base. Carry the
        // prior public shadows before checking the combined call-pair delta.
        if let Some(overlay) = prior.overlay {
            for path in overlay
                .shadows
                .iter()
                .filter(|path| !written.contains(*path))
            {
                writer.shadow(path).map_err(JobError::write)?;
                if let Some(file) = overlay.files.get(path) {
                    carry_file(writer, corpus, by_path[path.as_str()], file, true)?;
                }
            }
        }
        if !self.resolve.is_empty() || !self.removed.is_empty() {
            for path in writer.neighbouring_files().map_err(JobError::write)? {
                let (file, previous) = prior
                    .file(&path)
                    .expect("a retained neighbour has a publication");
                writer.shadow(&path).map_err(JobError::write)?;
                carry_file(writer, corpus, by_path[path.as_str()], file, previous)?;
            }
        }
        writer.carry_resolution_inputs().map_err(JobError::write)
    }
}

fn carry_file(
    writer: &mut Writer,
    corpus: &Corpus<'_>,
    input: &RequestFile,
    file: &BaseFile,
    previous: bool,
) -> Result<(), JobError> {
    writer
        .copy_declarations(file.key, previous)
        .map_err(JobError::write)?;
    build::index_source(
        writer,
        corpus.root,
        corpus.request,
        input,
        &file.hash,
        file.key,
    )?;
    writer
        .copy_outgoing_from(file.key, previous)
        .map_err(JobError::write)?;
    writer
        .set_file_resolution(file.key, &file.resolution)
        .map_err(JobError::write)
}

fn topology_readers(
    corpus: &Corpus<'_>,
    prior: &Publication<'_>,
    writer: &Writer,
    frontier: &mut VecDeque<String>,
) -> Result<bool, JobError> {
    use mex_graph_python::resolve::module_index;
    let paths = |language| {
        let mut before: Vec<_> = prior
            .paths()
            .filter(|path| Language::get(path, &corpus.request.languages) == Some(language))
            .collect();
        let mut after: Vec<_> = corpus
            .sizes
            .keys()
            .copied()
            .filter(|path| Language::get(path, &corpus.request.languages) == Some(language))
            .collect();
        before.sort_unstable();
        after.sort_unstable();
        (before, after)
    };
    let (before, after) = paths(Language::Python);
    if before != after {
        let left = module_index(before.iter().copied());
        let right = module_index(after.iter().copied());
        for key in left
            .keys()
            .chain(right.keys().filter(|key| !left.contains_key(*key)))
        {
            if left.get(key).map(|&i| before[i]) != right.get(key).map(|&i| after[i]) {
                frontier.extend(
                    writer
                        .readers("python-module", key)
                        .map_err(JobError::write)?,
                );
            }
        }
    }
    let (before, after) = paths(Language::Ecma);
    if before == after {
        return Ok(false);
    }
    let old = modules(corpus.root, before, corpus.configs);
    let new = modules(corpus.root, after, corpus.configs);
    let mut changed = false;
    for (kind, syntax) in [
        ("ts-import", Syntax::Import),
        ("ts-require", Syntax::Require),
    ] {
        for key in writer.read_keys(kind).map_err(JobError::write)? {
            let (path, specifier) = key
                .split_once('\0')
                .ok_or_else(|| JobError::request("Invalid module dependency"))?;
            if old.resolve(path, specifier, syntax) != new.resolve(path, specifier, syntax) {
                frontier.extend(writer.readers(kind, &key).map_err(JobError::write)?);
                changed = true;
            }
        }
    }
    Ok(changed)
}

struct FileKeys<'a> {
    prior: &'a Publication<'a>,
    new: HashMap<&'a str, i64>,
}

impl<'a> FileKeys<'a> {
    fn new(edited: &HashSet<&'a str>, prior: &'a Publication<'a>) -> Self {
        let mut next = prior
            .overlay
            .into_iter()
            .flat_map(|overlay| overlay.files.values().map(|file| file.key))
            .max()
            .unwrap_or_default()
            .max(mex_graph_core::store::OVERLAY_KEY_START);
        let mut paths: Vec<_> = edited
            .iter()
            .copied()
            .filter(|path| prior.file(path).is_none() && !prior.base_files.contains_key(*path))
            .collect();
        paths.sort_unstable();
        let new = paths
            .into_iter()
            .map(|path| {
                next += 1;
                (path, next)
            })
            .collect();
        Self { prior, new }
    }

    fn get(&self, path: &str) -> i64 {
        self.prior
            .file(path)
            .map(|(file, _)| file.key)
            .or_else(|| self.prior.base_files.get(path).map(|file| file.key))
            .unwrap_or_else(|| self.new[path])
    }
}

struct NodeKeys<'a> {
    prior: &'a Publication<'a>,
    keys: HashMap<String, i64>,
    next: i64,
}

impl<'a> NodeKeys<'a> {
    fn new(writer: &Writer, prior: &'a Publication<'a>) -> Result<Self, JobError> {
        Ok(Self {
            prior,
            keys: HashMap::new(),
            next: writer
                .previous_node_upper_bound()
                .map_err(JobError::write)?,
        })
    }

    fn key(&mut self, id: &str, allocate: bool) -> Result<i64, JobError> {
        if let Some(&key) = self.keys.get(id) {
            return Ok(key);
        }
        let mut key = self.prior.base.node_key(id).map_err(JobError::write)?;
        if key.is_none()
            && let Some(overlay) = self.prior.overlay
        {
            key = overlay.db.node_key(id).map_err(JobError::write)?;
        }
        let key = if let Some(key) = key {
            key
        } else if allocate {
            self.next += 1;
            self.next
        } else {
            return Err(JobError::request(format!("Missing projected node {id}")));
        };
        self.keys.insert(id.into(), key);
        Ok(key)
    }

    fn register(&mut self, ids: &[Option<String>]) -> Result<(), JobError> {
        for id in ids.iter().flatten() {
            self.key(id, true)?;
        }
        Ok(())
    }

    fn existing(&mut self, id: &str) -> Result<i64, JobError> {
        self.key(id, false)
    }

    fn borrowed<'b>(&self, ids: &'b [Option<String>]) -> HashMap<&'b str, i64> {
        ids.iter()
            .flatten()
            .map(|id| (id.as_str(), self.keys[id]))
            .collect()
    }
}

pub(super) struct FactLoader<'a> {
    load: &'a dyn Fn(&RequestFile) -> Result<Rc<FileFacts>, JobError>,
    slots: HashMap<&'a str, (&'a RequestFile, std::cell::OnceCell<Rc<FileFacts>>)>,
    problem: RefCell<Option<JobError>>,
    byte_limit: u64,
    loaded_bytes: Cell<u64>,
    over_budget: Cell<bool>,
}

impl<'a> FactLoader<'a> {
    pub(super) fn new(
        request: &'a Request,
        load: &'a dyn Fn(&RequestFile) -> Result<Rc<FileFacts>, JobError>,
        byte_limit: u64,
    ) -> Self {
        Self {
            load,
            slots: request
                .files
                .iter()
                .map(|file| (file.path.as_str(), (file, std::cell::OnceCell::new())))
                .collect(),
            problem: RefCell::new(None),
            byte_limit,
            loaded_bytes: Cell::new(0),
            over_budget: Cell::new(false),
        }
    }

    pub(super) fn get(&self, path: &str) -> &FileFacts {
        let (file, slot) = &self.slots[path];
        slot.get_or_init(|| {
            let bytes = self.loaded_bytes.get().saturating_add(file.size);
            if self.over_budget.get() || bytes > self.byte_limit {
                // Bounded edits are retried in a one-shot worker after
                // discarding all rows planned with these empty inputs.
                self.over_budget.set(true);
            } else {
                self.loaded_bytes.set(bytes);
                match (self.load)(file) {
                    Ok(facts) => return facts,
                    Err(error) => {
                        *self.problem.borrow_mut() = Some(error);
                    }
                }
            }
            Rc::new(FileFacts {
                path: path.into(),
                health: mex_graph_core::facts::Health {
                    status: ParseStatus::Failed,
                    ..Default::default()
                },
                ..Default::default()
            })
        })
    }

    pub(super) fn over_budget(&self) -> bool {
        self.over_budget.get()
    }

    pub(super) fn finish(self) -> Result<(), JobError> {
        self.problem.into_inner().map_or(Ok(()), Err)
    }
}

pub(super) fn activate(mut facts: FileFacts, enabled: &Enabled) -> Rc<FileFacts> {
    enabled.activate(std::slice::from_mut(&mut facts));
    Rc::new(facts)
}

pub(super) fn framework_set(
    writer: &Writer,
    configs: &[ConfigSource<'_>],
    changed: &HashMap<String, FileFacts>,
    removed: &HashSet<&str>,
) -> Result<Enabled, JobError> {
    let mut names = HashSet::new();
    for key in writer.read_keys(DETECTION).map_err(JobError::write)? {
        if writer
            .readers(DETECTION, &key)
            .map_err(JobError::write)?
            .iter()
            .any(|path| !changed.contains_key(path) && !removed.contains(path.as_str()))
        {
            names.insert(key);
        }
    }
    names.extend(
        changed
            .values()
            .flat_map(|file| &file.frameworks)
            .filter(|marker| marker.kind == DETECTION)
            .map(|marker| marker.name.clone()),
    );
    Ok(Enabled::with_detections(
        super::refresh::package_config(configs),
        &names,
    ))
}
