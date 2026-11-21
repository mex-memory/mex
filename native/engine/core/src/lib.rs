//! The MEX graph engine's core: everything that is the same for every language.
//!
//! Language adapters produce per-file facts; this crate owns the node identity
//! scheme, the facts contract and the resolver framework they share.

/// Version of the interface between Node and the engine. Bumped on any change
/// a caller could observe; Node refuses an engine with a different version.
pub const CONTRACT_VERSION: u32 = 2;

pub mod id;

pub mod facts;

pub mod store;

pub mod fingerprint;
pub mod text;
