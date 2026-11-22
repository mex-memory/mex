//! A checkout's packed extraction facts and its currently published resolution.
//! The regular refresh projection remains the authority for structural edits.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use mex_graph_core::facts::FileFacts;
use mex_graph_core::store::{BaseFile, BuildMetadata, RefreshBase, Writer};
use mex_graph_core::timing::{self, Timer};

use super::{build, node_ids, refresh};
use crate::facts_cache::{FactsCache, ResidentDecoder, ResidentFacts};
use crate::frameworks::Enabled;
use crate::job::{
    ExtractedFiles, JobCounts, JobError, Request, RequestConfig, RequestFile, decode_hash,
    extract_files, read_configs, repository_path, request_facts_key,
};

pub(crate) struct Edit {
    pub output: PathBuf,
    pub files: Vec<RequestFile>,
    pub deleted: Vec<String>,
    pub configs: Option<Vec<RequestConfig>>,
    pub source_directory: Option<PathBuf>,
    pub build_metadata: Option<BuildMetadata>,
    pub walk_observation: Option<String>,
}

pub(crate) struct Session {
    request: Request,
    base: RefreshBase,
    base_files: HashMap<String, BaseFile>,
    overlay: Option<PublishedOverlay>,
    facts: HashMap<String, ResidentFacts>,
    enabled: Option<Enabled>,
}

struct PublishedOverlay {
    path: PathBuf,
    db: RefreshBase,
    files: HashMap<String, BaseFile>,
    shadows: Vec<String>,
}

impl PublishedOverlay {
    fn open(path: PathBuf, base: &Path) -> Result<Self, JobError> {
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
        Ok(Self {
            path,
            db,
            files,
            shadows,
        })
    }
}

pub(crate) struct Pending {
    request: Request,
    facts: HashMap<String, ResidentFacts>,
    deleted: Vec<String>,
    enabled: Enabled,
}

impl Pending {
    pub(crate) fn files(&self) -> &[RequestFile] {
        &self.request.files
    }
}

impl Session {
    pub(crate) fn open(mut request: Request) -> Result<Self, JobError> {
        let _timer = Timer::start("resident.open");
        request.root = request.root.canonicalize().map_err(JobError::request_io)?;
        request.configs = capture_configs(&request.root, &request.configs);
        let base_path = request.base.as_deref().expect("validated serve base");
        let base = refresh::open_base(base_path)?;
        let base_files = base.files().map_err(JobError::write)?;
        let overlay = request
            .overlay
            .take()
            .map(|path| PublishedOverlay::open(path, base_path))
            .transpose()?;
        let count = overlay.as_ref().map_or(base_files.len(), |overlay| {
            base_files.len()
                - overlay
                    .shadows
                    .iter()
                    .filter(|path| base_files.contains_key(*path))
                    .count()
                + overlay.files.len()
        });
        if request.files.len() != count {
            return Err(JobError::request(
                "Serve inputs do not name the complete published corpus",
            ));
        }
        let cache = request
            .facts_cache
            .as_deref()
            .and_then(|dir| FactsCache::open(dir, count));
        let mut reader = cache.as_ref().and_then(FactsCache::reader);
        let mut facts = HashMap::with_capacity(count);
        let mut seen = HashSet::with_capacity(count);
        for file in &mut request.files {
            let path = &file.path;
            let old = match &overlay {
                Some(overlay) if overlay.shadows.binary_search(path).is_ok() => {
                    overlay.files.get(path)
                }
                _ => base_files.get(path),
            }
            .ok_or_else(|| {
                JobError::request(format!("File missing from the publication: {path}"))
            })?;
            let (language, version) = request_facts_key(path, &request.languages)
                .ok_or_else(|| JobError::request(format!("File has no enabled adapter: {path}")))?;
            if !seen.insert(path)
                || file.content_hash.as_deref().and_then(decode_hash) != Some(old.hash)
                || file.size != old.size
                || file.extractor_version.as_deref().unwrap_or("mex-graph") != old.extractor_version
            {
                return Err(JobError::request(format!(
                    "File does not match the publication: {path}"
                )));
            }
            file.staged = None;
            if let Some(packed) = reader
                .as_mut()
                .and_then(|reader| reader.pin(path, language, version, old.hash))
            {
                facts.insert(path.clone(), packed);
            }
        }
        // A cache miss on an old version can be legitimate when the first edit
        // is already on disk. Full resolution fills misses from the new corpus.
        let current = overlay.as_ref().map_or(&base, |overlay| &overlay.db);
        let configs = read_configs(&request.root, &request.configs);
        let enabled = (current.resolution_context().ok().as_deref()
            == Some(&build::resolution_context(
                &request.root,
                &request,
                &configs,
            )))
        .then(|| current.frameworks().ok())
        .flatten()
        .map(|names| Enabled::from_names(&names));
        sort_inputs(&mut request.files);
        Ok(Self {
            request,
            base,
            base_files,
            overlay,
            facts,
            enabled,
        })
    }

    pub(crate) fn output_path(&self, output: &Path) -> Result<(), JobError> {
        if !output.is_absolute()
            || output.parent() != self.base_path().parent()
            || !std::fs::symlink_metadata(output)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
        {
            return Err(JobError::request(
                "Output must be a new absolute sibling of the base",
            ));
        }
        Ok(())
    }

    fn base_path(&self) -> &Path {
        self.request.base.as_deref().expect("validated serve base")
    }

    pub(crate) fn edit(&self, edit: Edit) -> Result<(JobCounts, Pending), JobError> {
        let mut changes = HashSet::new();
        for path in edit
            .deleted
            .iter()
            .chain(edit.files.iter().map(|file| &file.path))
        {
            if !repository_path(path) || !changes.insert(path.as_str()) {
                return Err(JobError::request(
                    "Edit paths must be unique, repository-relative and normalized",
                ));
            }
        }
        if edit
            .files
            .iter()
            .any(|file| file.content_hash.as_deref().and_then(decode_hash).is_none())
        {
            return Err(JobError::request(
                "Edited sources require an exact content hash",
            ));
        }
        let (files, edited, observed) = self.updated_files(edit.files, &edit.deleted);
        let same_configs = edit.configs.is_none();
        let request = Request {
            root: self.request.root.clone(),
            mode: self.request.mode.clone(),
            contract: self.request.contract,
            limits: self.request.limits,
            base: self.request.base.clone(),
            overlay: None,
            files,
            configs: edit.configs.map_or_else(
                || self.request.configs.clone(),
                |configs| capture_configs(&self.request.root, &configs),
            ),
            languages: self.request.languages.clone(),
            frameworks: true,
            output: Some(edit.output),
            changed: Vec::new(),
            facts_cache: None,
            source_directory: edit.source_directory,
            observation_root: self.request.observation_root.clone(),
            walk_observation: edit.walk_observation,
            build_metadata: edit.build_metadata,
        };
        let inputs: Vec<_> = request
            .files
            .iter()
            .filter(|file| edited.contains(&file.path))
            .collect();
        let extracted = extract_files(&request.root, &request, &inputs, None);
        for entry in &extracted.files {
            extracted.file(entry).map_err(refresh::bad_source)?;
        }
        let mut changed: HashMap<_, _> = extracted
            .into_facts()
            .map(|facts| (facts.path.clone(), facts))
            .collect();
        let mut parsed = changed.len();
        let mut packed = HashMap::new();
        for (path, facts) in &changed {
            packed.insert(path.clone(), pack(facts)?);
        }
        let configs = read_configs(&request.root, &request.configs);
        let mut writer =
            Writer::overlay(request.candidate_path(), self.base_path()).map_err(JobError::write)?;
        let mut decoder = ResidentDecoder::default();
        let quick = self.enabled.as_ref().filter(|_| {
            same_configs
                && edit.deleted.is_empty()
                && changed.iter().all(|(path, new)| {
                    self.facts
                        .get(path)
                        .and_then(|previous| decoder.unpack(previous))
                        .is_some_and(|mut old| refresh::same_resolution_inputs(&mut old, new))
                })
                && self.overlay.as_ref().is_none_or(|overlay| {
                    overlay
                        .files
                        .keys()
                        .all(|path| self.facts.contains_key(path))
                })
        });
        let (enabled, context, copied_observations) = if let Some(enabled) = quick {
            timing::measure("resident.reuseResolution", || {
                self.reuse_resolution(&mut writer, &request, enabled, changed, &mut decoder)
            })?;
            let copied = if let Some(root) = &request.observation_root {
                timing::measure("v5.copyObservations", || {
                    writer.copy_source_observations(self.overlay.is_some(), root)
                })
                .map_err(JobError::write)?
            } else {
                false
            };
            let prior = self
                .overlay
                .as_ref()
                .map_or(&self.base, |overlay| &overlay.db);
            (
                enabled.clone(),
                prior.resolution_context().map_err(JobError::write)?,
                copied,
            )
        } else {
            let mut all = ExtractedFiles::default();
            let missing = timing::measure("resident.unpack", || {
                let mut missing = Vec::new();
                for file in &request.files {
                    if !changed.contains_key(&file.path) {
                        if let Some(facts) = self
                            .facts
                            .get(&file.path)
                            .and_then(|entry| decoder.unpack(entry))
                        {
                            changed.insert(file.path.clone(), facts);
                        } else {
                            missing.push(file);
                        }
                    }
                }
                missing
            });
            if !missing.is_empty() {
                let extracted = extract_files(&request.root, &request, &missing, None);
                for entry in &extracted.files {
                    extracted.file(entry).map_err(refresh::bad_source)?;
                }
                parsed += missing.len();
                for facts in extracted.into_facts() {
                    packed.insert(facts.path.clone(), pack(&facts)?);
                    changed.insert(facts.path.clone(), facts);
                }
            }
            for file in &request.files {
                let facts = changed
                    .remove(&file.path)
                    .expect("each input was decoded or extracted");
                all.push(facts, file.size);
            }
            let enabled = refresh::detect_frameworks(&all, &configs);
            all.activate(&enabled);
            refresh::resolve_and_shadow(
                &mut writer,
                &request.root,
                &request,
                &configs,
                &all,
                &enabled,
                &self.base,
                &self.base_files,
            )?;
            (
                enabled,
                build::resolution_context(&request.root, &request, &configs),
                false,
            )
        };
        writer
            .set_meta("frameworks", &enabled.names())
            .map_err(JobError::write)?;
        writer
            .set_meta("resolution_context", &context)
            .map_err(JobError::write)?;
        let counts = refresh::finish_with_observations(
            writer,
            &request,
            parsed,
            request
                .files
                .iter()
                .filter(|file| !copied_observations || observed.contains(&file.path)),
        )?;
        Ok((
            counts,
            Pending {
                request,
                facts: packed,
                deleted: edit.deleted,
                enabled,
            },
        ))
    }

    fn updated_files(
        &self,
        updates: Vec<RequestFile>,
        deleted: &[String],
    ) -> (Vec<RequestFile>, HashSet<String>, HashSet<String>) {
        let mut updates: HashMap<_, _> = updates
            .into_iter()
            .map(|file| (file.path.clone(), file))
            .collect();
        let observed = updates.keys().cloned().collect();
        let mut edited = HashSet::new();
        let removed: HashSet<_> = deleted.iter().map(String::as_str).collect();
        let mut files = Vec::with_capacity(self.request.files.len() + updates.len());
        for old in &self.request.files {
            if let Some(new) = updates.remove(&old.path) {
                if new.content_hash != old.content_hash
                    || new.size != old.size
                    || new.extractor_version != old.extractor_version
                {
                    edited.insert(new.path.clone());
                }
                files.push(new);
            } else if !removed.contains(old.path.as_str()) {
                files.push(old.clone());
            }
        }
        if !updates.is_empty() {
            edited.extend(updates.keys().cloned());
            files.extend(updates.into_values());
            sort_inputs(&mut files);
        }
        (files, edited, observed)
    }

    fn reuse_resolution(
        &self,
        writer: &mut Writer,
        request: &Request,
        enabled: &Enabled,
        mut changed: HashMap<String, FileFacts>,
        decoder: &mut ResidentDecoder,
    ) -> Result<(), JobError> {
        let mut shadows: HashSet<String> = changed.keys().cloned().collect();
        if let Some(previous) = &self.overlay {
            writer
                .attach_previous_overlay(&previous.path)
                .map_err(JobError::write)?;
            shadows.extend(previous.shadows.iter().cloned());
            for path in previous
                .shadows
                .iter()
                .filter(|path| !previous.files.contains_key(*path))
            {
                writer.shadow(path).map_err(JobError::write)?;
            }
        }
        for file in request
            .files
            .iter()
            .filter(|file| shadows.contains(file.path.as_str()))
        {
            let path = &file.path;
            let previous = self
                .overlay
                .as_ref()
                .and_then(|overlay| Some((&overlay.db, overlay.files.get(path)?)));
            let (source, old) = previous
                .or_else(|| Some((&self.base, self.base_files.get(path)?)))
                .ok_or_else(|| {
                    JobError::request("There is no prior resolution for an edited file")
                })?;
            let mut facts = changed
                .remove(path)
                .or_else(|| decoder.unpack(self.facts.get(path)?))
                .ok_or_else(|| JobError::request("Missing resident facts for an overlay file"))?;
            enabled.activate(std::slice::from_mut(&mut facts));
            let ids = node_ids(&facts);
            let mut nodes = HashMap::with_capacity(ids.len());
            for id in ids.iter().filter_map(Option::as_deref) {
                let key = source
                    .node_key(id)
                    .map_err(JobError::write)?
                    .ok_or_else(|| {
                        JobError::request("The published resolution is missing a node")
                    })?;
                nodes.insert(id, key);
            }
            refresh::write_shadow(
                writer,
                old.key,
                &old.resolution,
                refresh::FileInput {
                    input: file,
                    facts: &facts,
                    size: file.size,
                },
                &request.root,
                request,
                &nodes,
            )?;
            writer
                .copy_outgoing_from(old.key, previous.is_some())
                .map_err(JobError::write)?;
        }
        Ok(())
    }

    pub(crate) fn accept(
        &mut self,
        mut pending: Pending,
        overlay: PathBuf,
    ) -> Result<(), JobError> {
        let overlay = PublishedOverlay::open(overlay, self.base_path())?;
        for path in pending.deleted {
            self.facts.remove(&path);
        }
        self.facts.extend(pending.facts);
        for file in &mut pending.request.files {
            file.staged = None;
        }
        pending.request.source_directory = None;
        pending.request.build_metadata = None;
        self.request = pending.request;
        self.enabled = Some(pending.enabled);
        self.overlay = Some(overlay);
        Ok(())
    }
}

fn pack(facts: &FileFacts) -> Result<ResidentFacts, JobError> {
    ResidentFacts::pack(facts).ok_or_else(|| JobError::request("Unable to pack resident facts"))
}

fn sort_inputs(files: &mut [RequestFile]) {
    files.sort_unstable_by(|left, right| left.path.encode_utf16().cmp(right.path.encode_utf16()));
}

fn capture_configs(root: &Path, configs: &[RequestConfig]) -> Vec<RequestConfig> {
    read_configs(root, configs)
        .into_iter()
        .map(|(path, source)| RequestConfig::Source {
            path: path.into(),
            source: source.into_owned(),
        })
        .collect()
}
