//! A checkout's packed extraction facts and its currently published resolution.
//! The regular refresh projection remains the authority for structural edits.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use mex_graph_core::facts::FileFacts;
use mex_graph_core::store::{BaseFile, BuildMetadata, RefreshBase, Writer};
use mex_graph_core::timing::{self, Timer};
use mex_graph_ecmascript::modules::ModuleResolver;

use super::{
    build,
    incremental::{self, Corpus, FactLoader, Plan, Publication, PublishedOverlay},
    refresh,
};
use crate::facts_cache::{FactsCache, ResidentDecoder, ResidentFacts, ResidentFileCache};
use crate::job::{
    JobCounts, JobError, Request, RequestConfig, RequestFile, decode_hash, extract_files,
    read_configs, remove_candidate, repository_path, request_facts_key,
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
    decoder: RefCell<ResidentDecoder>,
    decoded_files: RefCell<ResidentFileCache>,
    modules: ModuleResolver,
    context: String,
}

pub(crate) struct Pending {
    request: Request,
    facts: HashMap<String, ResidentFacts>,
    discard_facts: Vec<String>,
    modules: Option<ModuleResolver>,
    context: String,
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
        sort_inputs(&mut request.files);
        let configs = read_configs(&request.root, &request.configs);
        let modules = incremental::project_modules(&request.root, &request, &configs);
        let context = build::resolution_context(&request.root, &request, &configs);
        let decoder = ResidentDecoder::new(8 * 1024 * 1024)
            .ok_or_else(|| JobError::request("Unable to allocate a resident facts decoder"))?;
        Ok(Self {
            request,
            base,
            base_files,
            overlay,
            facts,
            decoder: RefCell::new(decoder),
            decoded_files: RefCell::default(),
            modules,
            context,
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
        let config_upsert = edit.configs.is_some();
        let request = Request {
            root: self.request.root.clone(),
            module_root: None,
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
            facts_cache: self.request.facts_cache.clone(),
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
        let configs = read_configs(&request.root, &request.configs);
        let context = if config_upsert {
            build::resolution_context(&request.root, &request, &configs)
        } else {
            self.context.clone()
        };
        let topology_changed =
            !edit.deleted.is_empty() || request.files.len() != self.request.files.len();
        let replacement_modules = (topology_changed || context != self.context)
            .then(|| incremental::project_modules(&request.root, &request, &configs));
        let input_bytes = inputs
            .iter()
            .fold(0u64, |sum, file| sum.saturating_add(file.size));
        if inputs.len() > MAX_RESIDENT_ORIGINS || input_bytes > MAX_RESIDENT_SOURCE_BYTES {
            let discard_facts = edit.deleted.into_iter().chain(edited).collect();
            let counts = timing::measure("resident.oneShot", || self.one_shot(&request))?;
            return Ok((
                counts,
                Pending {
                    request,
                    facts: HashMap::new(),
                    discard_facts,
                    modules: replacement_modules,
                    context,
                },
            ));
        }
        let extracted = extract_files(&request.root, &request, &inputs, None);
        for entry in &extracted.files {
            extracted.file(entry).map_err(refresh::bad_source)?;
        }
        let changed: HashMap<_, _> = extracted
            .into_facts()
            .map(|facts| (facts.path.clone(), facts))
            .collect();
        let packed = changed
            .iter()
            .map(|(path, facts)| Ok((path.clone(), pack(facts)?)))
            .collect::<Result<HashMap<_, _>, JobError>>()?;
        let mut writer =
            Writer::overlay(request.candidate_path(), self.base_path()).map_err(JobError::write)?;
        if let Some(overlay) = &self.overlay {
            writer
                .attach_previous_overlay(&overlay.path)
                .map_err(JobError::write)?;
        }
        let prior = Publication {
            base: &self.base,
            base_files: &self.base_files,
            overlay: self.overlay.as_ref(),
        };
        let sizes: HashMap<_, _> = request
            .files
            .iter()
            .map(|file| (file.path.as_str(), file.size))
            .collect();
        let removed = prior
            .paths()
            .filter(|path| !sizes.contains_key(path))
            .collect::<HashSet<_>>();
        let enabled = incremental::framework_set(&writer, &configs, &changed, &removed)?;
        let modules = replacement_modules.as_ref().unwrap_or(&self.modules);
        let complete = context
            != prior
                .current()
                .resolution_context()
                .map_err(JobError::write)?
            || enabled.names() != prior.current().frameworks().map_err(JobError::write)?;
        let missing = std::cell::RefCell::new(HashMap::new());
        let load = |file: &RequestFile| {
            if let Some(facts) = changed.get(&file.path) {
                return Ok(incremental::activate(facts.clone(), &enabled));
            }
            if let Some(facts) = self.decoded_files.borrow().get(&file.path) {
                return Ok(facts);
            }
            if let Some(entry) = self.facts.get(&file.path)
                && let Some(facts) = timing::measure("resident.unpack", || {
                    self.decoder.borrow_mut().unpack(entry)
                })
            {
                let facts = incremental::activate(facts, &enabled);
                self.decoded_files
                    .borrow_mut()
                    .insert(&file.path, &facts, entry.encoded_size());
                return Ok(facts);
            }
            let extracted = extract_files(&request.root, &request, &[file], None);
            for entry in &extracted.files {
                extracted.file(entry).map_err(refresh::bad_source)?;
            }
            let facts = extracted
                .into_facts()
                .next()
                .ok_or_else(|| JobError::request("Missing resolver facts"))?;
            missing
                .borrow_mut()
                .insert(file.path.clone(), pack(&facts)?);
            Ok(incremental::activate(facts, &enabled))
        };
        let loader = FactLoader::new(&request, &load, MAX_RESIDENT_SOURCE_BYTES);
        let in_process = if complete {
            false
        } else {
            let load = |path: &str| loader.get(path);
            let corpus = Corpus {
                root: &request.root,
                request: &request,
                configs: &configs,
                sizes: &sizes,
                load: &load,
                modules: Some(modules),
                identities: None,
            };
            let function_delta = |path: &str, hash| {
                let old = self.decoder.borrow_mut().unpack(self.facts.get(path)?)?;
                if old.content_hash != hash {
                    return None;
                }
                super::edit_facts::function_delta(&old, changed.get(path)?)
            };
            let plan = Plan::new(
                &corpus,
                &prior,
                &writer,
                false,
                inputs.iter().copied(),
                function_delta,
            )?;
            if loader.over_budget() || plan.resolution_count() > MAX_RESIDENT_ORIGINS {
                false
            } else {
                let result = plan.write(&corpus, &mut writer, &enabled, &prior);
                if loader.over_budget() {
                    false
                } else {
                    result?;
                    true
                }
            }
        };
        loader.finish()?;
        if !in_process {
            drop(writer);
            remove_candidate(Some(request.candidate_path()));
            let counts = timing::measure("resident.oneShot", || self.one_shot(&request))?;
            return Ok((
                counts,
                Pending {
                    request,
                    facts: packed,
                    discard_facts: edit.deleted,
                    modules: replacement_modules,
                    context,
                },
            ));
        }
        let mut packed = packed;
        packed.extend(missing.into_inner());
        let parsed = packed.len();
        let copied_observations = if let Some(root) = &request.observation_root {
            let copied = timing::measure("v5.copyObservations", || {
                writer.copy_source_observations(self.overlay.is_some(), root)
            })
            .map_err(JobError::write)?;
            if copied {
                for path in &removed {
                    writer
                        .remove_source_observation(path)
                        .map_err(JobError::write)?;
                }
            }
            copied
        } else {
            false
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
                discard_facts: edit.deleted,
                modules: replacement_modules,
                context,
            },
        ))
    }

    /// Large resolver arenas belong to a short-lived process. It runs the
    /// same refresh planner against the same captured sources and publication.
    fn one_shot(&self, request: &Request) -> Result<JobCounts, JobError> {
        let mut request = request.clone();
        request.mode = "refresh".into();
        request.overlay = self.overlay.as_ref().map(|overlay| overlay.path.clone());
        // Serve frames always give a complete, hash-verified request. When
        // no source spool is needed, use the checkout itself for live reads.
        request
            .source_directory
            .get_or_insert_with(|| request.root.clone());
        request.limits.deadline_ms = request.limits.deadline_ms.min(120_000);
        let mut path = request.candidate_path().as_os_str().to_owned();
        path.push("-edit-request");
        let path = PathBuf::from(path);
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(&path).map_err(JobError::request_io)?;
        let _frame = WorkerRequest(path);
        serde_json::to_writer(file, &request).map_err(JobError::write)?;
        let mut worker = Command::new(std::env::current_exe().map_err(JobError::request_io)?)
            .arg("refresh")
            .arg("--request")
            .arg(&_frame.0)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(JobError::request_io)?;
        // The job's stdin guard sees EOF if this resident process exits.
        let mut stdin = worker.stdin.take().expect("piped stdin");
        stdin.write_all(b"start\n").map_err(JobError::request_io)?;
        let output = worker.wait_with_output().map_err(JobError::request_io)?;
        drop(stdin);
        let result: serde_json::Value = output
            .stdout
            .split(|&byte| byte == b'\n')
            .filter_map(|line| serde_json::from_slice(line).ok())
            .next_back()
            .ok_or_else(|| JobError::request("Refresh worker returned no result"))?;
        if !output.status.success() || result["type"] != "result" {
            return Err(JobError::request(format!(
                "Refresh worker failed: {}",
                result["message"].as_str().unwrap_or("missing result")
            )));
        }
        let count = |key: &str| {
            result[key]
                .as_u64()
                .and_then(|n| usize::try_from(n).ok())
                .ok_or_else(|| JobError::request(format!("Refresh worker omitted {key}")))
        };
        Ok(JobCounts {
            files: count("files")?,
            nodes: count("nodes")?,
            edges: count("edges")?,
            coverage_gaps: count("coverageGaps")?,
            reextracted: count("filesReextracted")?,
            shadowed: Some(count("shadowedFiles")?),
        })
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

    pub(crate) fn accept(
        &mut self,
        mut pending: Pending,
        overlay: PathBuf,
    ) -> Result<(), JobError> {
        let overlay = PublishedOverlay::open(overlay, self.base_path())?;
        let mut decoded = self.decoded_files.borrow_mut();
        let previous = self
            .overlay
            .as_ref()
            .map_or(&self.base, |overlay| &overlay.db);
        if previous.frameworks().map_err(JobError::write)?
            != overlay.db.frameworks().map_err(JobError::write)?
        {
            *decoded = ResidentFileCache::default();
        }
        for path in pending.discard_facts {
            self.facts.remove(&path);
            decoded.remove(&path);
        }
        for path in pending.facts.keys() {
            decoded.remove(path);
        }
        self.facts.extend(pending.facts);
        for file in &mut pending.request.files {
            file.staged = None;
        }
        pending.request.source_directory = None;
        pending.request.build_metadata = None;
        self.request = pending.request;
        if let Some(modules) = pending.modules {
            self.modules = modules;
        }
        self.context = pending.context;
        self.overlay = Some(overlay);
        Ok(())
    }
}

const MAX_RESIDENT_ORIGINS: usize = 192;
const MAX_RESIDENT_SOURCE_BYTES: u64 = 8 * 1024 * 1024;

struct WorkerRequest(PathBuf);

impl Drop for WorkerRequest {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
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
