//! ECMAScript support for the MEX graph engine.

pub mod modules;
pub mod resolve;
pub mod scanner;

mod nodes;
pub use nodes::{EcmaScript, language_for_path};
