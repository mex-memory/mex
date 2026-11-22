//! File access for language resolvers. Paths are cheap to index globally;
//! only a lookup that needs a declaration or a binding opens its facts.

use crate::facts::FileFacts;

pub enum Access<'a> {
    Origin(usize),
    Enter(usize),
    Leave,
    File(usize),
    Lookup(&'static str, &'a str),
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

    pub fn lookup(self, kind: &'static str, key: &str) {
        if let Self::Lazy { observe, .. } = self {
            observe(Access::Lookup(kind, key));
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

    pub fn paths(self) -> impl Iterator<Item = &'a str> + Clone {
        (0..self.len()).map(move |file| self.path(file))
    }
}
