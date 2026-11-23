//! The embedded language registry. Invalid entries never reach extraction.

use std::borrow::Cow;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::num::NonZeroU16;
use std::sync::OnceLock;

use mex_graph_core::facts::{FACTS_VERSION, ImportForm};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tree_sitter::{Language, Node, Parser};

use crate::hex;
use crate::syntax_language::SyntaxLanguage;

include!(concat!(env!("OUT_DIR"), "/adapters.rs"));

pub(crate) const BASIC: &str = "basic";
const BASIC_VERSION: u32 = 1;

pub(crate) fn registry() -> &'static Registry {
    static REGISTRY: OnceLock<Registry> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        let mut registry = Registry::default();
        let warn = |message: &str| eprintln!("mex-graph: warning: {message}");
        registry.load(MANIFEST, CONFIGS, warn);
        #[cfg(test)]
        registry.load(
            include_bytes!("../tests/fixtures/basic/registry.toml"),
            &[
                (
                    "sample/sample.toml",
                    include_bytes!("../tests/fixtures/basic/sample/sample.toml"),
                ),
                (
                    "broken/broken.toml",
                    include_bytes!("../tests/fixtures/basic/broken/broken.toml"),
                ),
            ],
            warn,
        );
        registry
    })
}

#[derive(Default)]
pub(crate) struct Registry {
    adapters: Vec<Adapter>,
    ids: HashMap<String, usize>,
    extensions: HashMap<String, usize>,
}

impl Registry {
    fn load(&mut self, source: &[u8], configs: &[(&str, &[u8])], mut warn: impl FnMut(&str)) {
        let manifest = match parse::<Manifest>(source) {
            Ok(manifest) => manifest,
            Err(error) => {
                warn(&format!("skipping registry.toml: {error}"));
                return;
            }
        };
        let mut entries = Vec::new();
        for (index, entry) in manifest.language.into_iter().enumerate() {
            match entry.try_into::<Entry>() {
                Ok(entry) => entries.push(entry),
                Err(error) => warn(&format!(
                    "skipping registry.toml entry {}: {error}",
                    index + 1
                )),
            }
        }
        // The first valid full entry owns its claims, even if a basic entry
        // appears earlier in the manifest. Within each level use file order.
        for level in [Level::Full, Level::Basic] {
            for entry in entries.iter().filter(|entry| entry.level == level) {
                let path = format!("{}/{}.toml", entry.folder, entry.id);
                let config = configs
                    .iter()
                    .find(|(key, _)| *key == path)
                    .map(|(_, text)| *text);
                if let Err(error) = self.register(entry, config) {
                    warn(&format!("skipping adapter {} ({path}): {error}", entry.id));
                }
            }
        }
    }

    fn register(&mut self, entry: &Entry, source: Option<&[u8]>) -> Result<(), String> {
        if !identifier(&entry.id) || !identifier(&entry.folder) {
            return Err("invalid id or folder".into());
        }
        if self.ids.contains_key(&entry.id) {
            return Err("id is already registered".into());
        }
        let source = source.ok_or("missing config")?;
        let config: Config = parse(source)?;
        if config.adapter_version == 0 || config.extensions.is_empty() {
            return Err("adapter_version and extensions must be nonempty".into());
        }
        let mut seen = HashSet::new();
        let mut extensions = Vec::with_capacity(config.extensions.len());
        for extension in &config.extensions {
            let extension = extension.to_ascii_lowercase();
            if !extension.strip_prefix('.').is_some_and(identifier) {
                return Err(format!("invalid extension {extension:?}"));
            }
            if !seen.insert(extension.clone()) {
                return Err(format!("duplicate extension {extension}"));
            }
            if let Some(&owner) = self.extensions.get(&extension) {
                return Err(format!(
                    "extension {extension} is already claimed by {}",
                    self.adapters[owner].info.id
                ));
            }
            extensions.push(extension);
        }
        let rules = config.compile(&config.grammar.language())?;
        let implementation = match entry.level {
            Level::Full => config.full(&entry.id, &extensions)?,
            Level::Basic => {
                let mut parser = Parser::new();
                parser
                    .set_language(&config.grammar.language())
                    .map_err(|error| error.to_string())?;
                Implementation::Basic(rules)
            }
        };
        let basic_key = (entry.level == Level::Basic).then(|| {
            format!(
                "{BASIC_VERSION}:{FACTS_VERSION}:{}:{}:{}",
                entry.id,
                config.grammar.version(),
                hex(&Sha256::digest(source))
            )
        });
        let index = self.adapters.len();
        for extension in &extensions {
            self.extensions.insert(extension.clone(), index);
        }
        self.ids.insert(entry.id.clone(), index);
        self.adapters.push(Adapter {
            info: Info {
                id: entry.id.clone(),
                level: entry.level,
                extensions,
                grammar_version: config.grammar.version(),
                adapter_version: config.adapter_version,
            },
            grammar: config.grammar,
            implementation,
            basic_key,
        });
        Ok(())
    }

    pub(crate) fn languages(&self) -> Vec<&Info> {
        self.adapters.iter().map(|adapter| &adapter.info).collect()
    }

    pub(crate) fn for_path(&self, path: &str) -> Option<&Adapter> {
        let filename = path.rsplit(['/', '\\']).next()?;
        let (stem, _) = filename.rsplit_once('.')?;
        let extension = &filename[stem.len()..];
        let extension = if extension.bytes().any(|byte| byte.is_ascii_uppercase()) {
            Cow::Owned(extension.to_ascii_lowercase())
        } else {
            Cow::Borrowed(extension)
        };
        self.extensions
            .get(extension.as_ref())
            .map(|&index| &self.adapters[index])
    }

    pub(crate) fn is_basic(&self, language: &str) -> bool {
        self.ids
            .get(language)
            .is_some_and(|&index| self.adapters[index].info.level == Level::Basic)
    }

    pub(crate) fn basic_fingerprint(&self) -> Option<String> {
        let keys: Vec<_> = self
            .adapters
            .iter()
            .filter_map(|adapter| adapter.basic_key.as_deref())
            .collect();
        (!keys.is_empty()).then(|| hex(&Sha256::digest(keys.join("\n"))))
    }
}

fn identifier(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 64
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_')
}

fn parse<T: serde::de::DeserializeOwned>(source: &[u8]) -> Result<T, String> {
    let source = std::str::from_utf8(source).map_err(|error| error.to_string())?;
    toml::from_str(source).map_err(|error| error.to_string())
}

#[derive(Deserialize)]
struct Manifest {
    language: Vec<toml::Value>,
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum Level {
    Full,
    Basic,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    id: String,
    folder: String,
    level: Level,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    grammar: Grammar,
    adapter_version: u32,
    extensions: Vec<String>,
    functions: BTreeMap<String, String>,
    classes: BTreeMap<String, String>,
    imports: BTreeMap<String, String>,
    calls: BTreeMap<String, String>,
}

impl Config {
    fn full(&self, id: &str, extensions: &[String]) -> Result<Implementation, String> {
        use Implementation::{EcmaScript, Python, Syntax};
        let (implementation, grammar, version) = match id {
            "python" => (Python, Grammar::Python, mex_graph_python::ADAPTER_VERSION),
            "rust" => (
                Syntax(SyntaxLanguage::Rust),
                Grammar::Rust,
                mex_graph_rust::ADAPTER_VERSION,
            ),
            "csharp" => (
                Syntax(SyntaxLanguage::CSharp),
                Grammar::CSharp,
                mex_graph_csharp::ADAPTER_VERSION,
            ),
            "javascript" | "jsx" => (
                EcmaScript,
                Grammar::JavaScript,
                mex_graph_ecmascript::ADAPTER_VERSION,
            ),
            "typescript" => (
                EcmaScript,
                Grammar::TypeScript,
                mex_graph_ecmascript::ADAPTER_VERSION,
            ),
            "tsx" => (
                EcmaScript,
                Grammar::Tsx,
                mex_graph_ecmascript::ADAPTER_VERSION,
            ),
            _ => return Err("no linked full adapter for this id".into()),
        };
        if grammar != self.grammar || version != self.adapter_version {
            return Err("grammar or adapter_version differs from the linked adapter".into());
        }
        if matches!(implementation, EcmaScript)
            && extensions.iter().any(|ext| {
                mex_graph_ecmascript::language_for_path(&format!("file{ext}")) != Some(id)
            })
        {
            return Err("extension differs from the linked ECMAScript adapter".into());
        }
        Ok(implementation)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Grammar {
    Python,
    Rust,
    CSharp,
    JavaScript,
    TypeScript,
    Tsx,
}

impl Grammar {
    pub(crate) fn language(self) -> Language {
        match self {
            Self::Python => mex_graph_python::grammar(),
            Self::Rust => mex_graph_rust::grammar(),
            Self::CSharp => mex_graph_csharp::grammar(),
            Self::JavaScript => mex_graph_ecmascript::linked_grammar("javascript").unwrap(),
            Self::TypeScript => mex_graph_ecmascript::linked_grammar("typescript").unwrap(),
            Self::Tsx => mex_graph_ecmascript::linked_grammar("tsx").unwrap(),
        }
    }

    fn version(self) -> &'static str {
        match self {
            Self::Python => "0.21.0",
            Self::Rust => "0.20.4",
            Self::CSharp => "0.23.5",
            Self::JavaScript => "0.25.0",
            Self::TypeScript | Self::Tsx => "0.23.2",
        }
    }

    pub(crate) fn import_form(self) -> ImportForm {
        match self {
            Self::Python => ImportForm::Python,
            Self::Rust => ImportForm::RustUse,
            Self::CSharp => ImportForm::CSharpUsing,
            Self::JavaScript | Self::TypeScript | Self::Tsx => ImportForm::Es,
        }
    }
}

impl Config {
    fn compile(&self, grammar: &Language) -> Result<HashMap<String, Rule>, String> {
        let mut rules = HashMap::new();
        for (role, table) in [
            (Role::Function, &self.functions),
            (Role::Class, &self.classes),
            (Role::Import, &self.imports),
            (Role::Call, &self.calls),
        ] {
            for (kind, path) in table {
                let id = grammar.id_for_node_kind(kind, true);
                if id == 0
                    || !grammar.node_kind_is_named(id)
                    || grammar.node_kind_for_id(id) != Some(kind)
                {
                    return Err(format!("unknown named syntax node {kind:?}"));
                }
                let path = path
                    .split('.')
                    .map(|step| {
                        if let Ok(index) = step.parse::<u16>() {
                            Ok(Step::Child(index))
                        } else if let Some(field) = grammar.field_id_for_name(step) {
                            Ok(Step::Field(field))
                        } else {
                            Err(format!("unknown name field {step:?} for {kind}"))
                        }
                    })
                    .collect::<Result<_, _>>()?;
                if rules.insert(kind.clone(), Rule { role, path }).is_some() {
                    return Err(format!("syntax node {kind:?} has more than one role"));
                }
            }
        }
        Ok(rules)
    }
}

#[derive(Clone, Copy)]
pub(crate) enum Role {
    Function,
    Class,
    Import,
    Call,
}

enum Step {
    Field(NonZeroU16),
    Child(u16),
}

pub(crate) struct Rule {
    pub(crate) role: Role,
    path: Vec<Step>,
}

impl Rule {
    pub(crate) fn name_node<'a>(&self, mut node: Node<'a>) -> Option<Node<'a>> {
        for step in &self.path {
            node = match *step {
                Step::Field(field) => node.child_by_field_id(field.get())?,
                Step::Child(index) => node.named_child(u32::from(index))?,
            };
        }
        (!node.is_missing()).then_some(node)
    }
}

pub(crate) enum Implementation {
    Python,
    EcmaScript,
    Syntax(SyntaxLanguage),
    Basic(HashMap<String, Rule>),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Info {
    id: String,
    level: Level,
    extensions: Vec<String>,
    grammar_version: &'static str,
    adapter_version: u32,
}

pub(crate) struct Adapter {
    info: Info,
    pub(crate) grammar: Grammar,
    pub(crate) implementation: Implementation,
    basic_key: Option<String>,
}

impl Adapter {
    pub(crate) fn id(&self) -> &str {
        &self.info.id
    }

    pub(crate) fn facts_key(&self, framework_version: u32) -> (&str, String) {
        let version = self.basic_key.clone().unwrap_or_else(|| {
            format!(
                "{}:{FACTS_VERSION}:{}:{framework_version}",
                self.id(),
                self.info.adapter_version
            )
        });
        (self.id(), version)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &[u8] = include_bytes!("../tests/fixtures/basic/sample/sample.toml");
    const BROKEN: &[u8] = include_bytes!("../tests/fixtures/basic/broken/broken.toml");

    #[test]
    fn skips_bad_entries_and_keeps_first_extension_owner() {
        let manifest = br#"
            [[language]]
            id = "shadow"
            folder = "shadow"
            level = "basic"
            [[language]]
            id = "python"
            folder = "python"
            level = "full"
            [[language]]
            id = "rust"
            folder = "rust"
            level = "full"
            [[language]]
            id = "broken"
            folder = "broken"
            level = "basic"
            [[language]]
            id = "typo"
            folder = "typo"
            level = "basic"
            [[language]]
            id = "sample"
            folder = "sample"
            level = "basic"
            [[language]]
            id = "duplicate"
            folder = "duplicate"
            level = "basic"
            [[language]]
            id = "invalid-entry"
            folder = 3
            level = "basic"
        "#;
        let sample = std::str::from_utf8(SAMPLE).unwrap();
        let shadow = sample.replace(".sample", ".PY");
        let rust = include_str!("../../langs/rust/rust.toml").replace(".rs", ".py");
        let duplicate = sample.replace(
            "extensions = [\".sample\"]",
            "extensions = [\".another\", \".SAMPLE\"]",
        );
        let typo = sample.replace("function_definition", "function_does_not_exist");
        let mut registry = Registry::default();
        let mut warnings = Vec::new();
        registry.load(
            manifest,
            &[
                ("shadow/shadow.toml", shadow.as_bytes()),
                (
                    "python/python.toml",
                    include_bytes!("../../langs/python/python.toml"),
                ),
                ("rust/rust.toml", rust.as_bytes()),
                ("broken/broken.toml", BROKEN),
                ("typo/typo.toml", typo.as_bytes()),
                ("sample/sample.toml", SAMPLE),
                ("duplicate/duplicate.toml", duplicate.as_bytes()),
            ],
            |warning| warnings.push(warning.to_owned()),
        );
        assert_eq!(registry.for_path("script.py").unwrap().id(), "python");
        assert_eq!(registry.for_path("fixture.SAMPLE").unwrap().id(), "sample");
        assert!(registry.for_path("fixture.another").is_none());
        assert_eq!(registry.languages().len(), 2);
        assert_eq!(warnings.len(), 6, "{warnings:?}");
        for (entry, detail) in [
            ("entry 8", "folder"),
            ("adapter rust", "claimed by python"),
            ("adapter shadow", "claimed by python"),
            ("adapter broken", "TOML parse error"),
            ("adapter typo", "unknown named syntax node"),
            ("adapter duplicate", "claimed by sample"),
        ] {
            assert!(
                warnings
                    .iter()
                    .any(|warning| warning.contains(entry) && warning.contains(detail)),
                "missing {entry}: {warnings:?}"
            );
        }
    }
}
