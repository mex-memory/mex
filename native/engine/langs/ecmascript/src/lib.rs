//! ECMAScript support for the MEX graph engine.

pub mod modules;
pub mod resolve;
pub mod scanner;

mod nodes;
pub use nodes::{EcmaScript, language_for_path, linked_grammar};

pub const ADAPTER_VERSION: u32 = 2;
