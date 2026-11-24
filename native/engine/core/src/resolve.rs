//! File access for language resolvers. Paths are cheap to index globally;
//! only a lookup that needs a declaration or a binding opens its facts.

use crate::facts::FileFacts;

#[derive(Clone, Copy, Hash, PartialEq, Eq)]
#[repr(u8)]
pub enum LookupKind {
    Path = 1,
    PythonModule = 2,
    RustCrate = 3,
    CSharpType = 4,
    TsImport = 5,
    TsRequire = 6,
    TsDispatch = 7,
    TsHeritage = 8,
    FunctionName = 9,
    TsForcedImport = 10,
    TsForcedRequire = 11,
}

pub enum Access<'a> {
    Origin(usize),
    Enter(usize),
    Leave,
    StartMemo(usize),
    EndMemo,
    ReadMemo(usize),
    File(usize),
    Import(usize, usize),
    Name(usize, &'a str),
    Lookup(LookupKind, &'a str),
}

#[derive(Clone, Copy)]
pub enum Files<'a> {
    Dense(&'a [FileFacts]),
    Lazy {
        paths: &'a [&'a str],
        load: &'a dyn Fn(usize) -> &'a FileFacts,
        observe: &'a dyn Fn(Access<'_>),
    },
}

impl<'a> Files<'a> {
    pub fn len(self) -> usize {
        match self {
            Self::Dense(files) => files.len(),
            Self::Lazy { paths, .. } => paths.len(),
        }
    }

    pub fn is_empty(self) -> bool {
        self.len() == 0
    }

    pub fn path(self, file: usize) -> &'a str {
        match self {
            Self::Dense(files) => &files[file].path,
            Self::Lazy { paths, .. } => paths[file],
        }
    }

    pub fn get(self, file: usize) -> &'a FileFacts {
        match self {
            Self::Dense(files) => &files[file],
            Self::Lazy { load, observe, .. } => {
                observe(Access::File(file));
                load(file)
            }
        }
    }

    pub fn origin(self, file: usize) {
        if let Self::Lazy { observe, .. } = self {
            observe(Access::Origin(file));
        }
    }

    pub fn lookup(self, kind: LookupKind, key: &str) {
        if let Self::Lazy { observe, .. } = self {
            observe(Access::Lookup(kind, key));
        }
    }

    pub fn import(self, file: usize, index: usize) {
        if let Self::Lazy { observe, .. } = self {
            observe(Access::Import(file, index));
        }
    }

    /// A declaration lookup, including a miss. The planner can distinguish
    /// these reads from whole-file reads for a change to one function name.
    pub fn name(self, file: usize, name: &str) {
        if let Self::Lazy { observe, .. } = self {
            observe(Access::Name(file, name));
        }
    }

    pub fn within<T>(self, file: usize, run: impl FnOnce() -> T) -> T {
        match self {
            Self::Dense(_) => run(),
            Self::Lazy { observe, .. } => {
                observe(Access::Enter(file));
                let result = run();
                observe(Access::Leave);
                result
            }
        }
    }

    pub fn within_memo<T>(self, memo: usize, run: impl FnOnce() -> T) -> T {
        match self {
            Self::Dense(_) => run(),
            Self::Lazy { observe, .. } => {
                observe(Access::StartMemo(memo));
                let result = run();
                observe(Access::EndMemo);
                result
            }
        }
    }

    pub fn read_memo(self, memo: usize) {
        if let Self::Lazy { observe, .. } = self {
            observe(Access::ReadMemo(memo));
        }
    }

    pub fn paths(self) -> impl Iterator<Item = &'a str> + Clone {
        (0..self.len()).map(move |file| self.path(file))
    }
}
