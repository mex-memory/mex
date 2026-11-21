//! Body hashes and MinHash fingerprints, as `src/graph/fingerprint.ts` and
//! `engine-impl.ts` compute them today.
//!
//! Grounded documentation stores both: the body hash decides drift, and the
//! fingerprint (committed as `mh2:`) lets a renamed or moved declaration be
//! found again. Both must equal what TypeScript produced for the same source.

use std::collections::HashMap;

use sha2::{Digest, Sha256};

use crate::id::collapse_whitespace;

/// Seeds per sketch (`K` in `src/graph/config.ts`).
pub const K: usize = 64;
/// Below this many tokens a sketch never decides a match on its own.
pub const MIN_TOKENS: usize = 30;

/// SHA-256 of a node's lines (1-based, inclusive), joined by `\n` with
/// whitespace collapsed: `bodyHash` in `engine-impl.ts`.
pub fn body_hash(lines: &[&str], start_line: usize, end_line: usize) -> [u8; 32] {
    let from = start_line.saturating_sub(1).min(lines.len());
    let to = end_line.min(lines.len()).max(from);
    let text = collapse_whitespace(&lines[from..to].join("\n"));
    Sha256::digest(text.as_bytes()).into()
}

/// The first four bytes, big-endian, of SHA-256(seed as decimal, NUL, value).
fn hash32(value: &str, seed: usize) -> u32 {
    let mut hasher = Sha256::new();
    hasher.update(seed.to_string().as_bytes());
    hasher.update([0u8]);
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]])
}

/// One node's sketch: the minimum of each seed's hash over its distinct token
/// trigrams, and how many tokens it saw.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Sketch {
    pub minhash: [u32; K],
    pub token_count: usize,
}

impl Sketch {
    /// The stored form: 64 big-endian u32 values.
    pub fn minhash_bytes(&self) -> Vec<u8> {
        self.minhash.iter().flat_map(|v| v.to_be_bytes()).collect()
    }
}

/// Builds sketches for one corpus, remembering each trigram's 64 hashes:
/// tokens discard spellings, so the same few trigrams recur everywhere.
#[derive(Default)]
pub struct SketchBuilder {
    trigram_hashes: HashMap<String, Box<[u32; K]>>,
}

impl SketchBuilder {
    pub fn sketch<S: AsRef<str>>(&mut self, tokens: &[S]) -> Sketch {
        let mut minima = [u32::MAX; K];
        let mut seen = std::collections::HashSet::new();
        for window in tokens.windows(3) {
            let trigram = format!(
                "{}\0{}\0{}",
                window[0].as_ref(),
                window[1].as_ref(),
                window[2].as_ref()
            );
            if !seen.insert(trigram.clone()) {
                continue;
            }
            let hashes = self.trigram_hashes.entry(trigram).or_insert_with_key(|t| {
                let mut out = Box::new([0u32; K]);
                for (seed, slot) in out.iter_mut().enumerate() {
                    *slot = hash32(t, seed);
                }
                out
            });
            for (min, h) in minima.iter_mut().zip(hashes.iter()) {
                *min = (*min).min(*h);
            }
        }
        Sketch {
            minhash: minima,
            token_count: tokens.len(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fewer_than_three_tokens_sketch_to_the_maximum() {
        let sketch = SketchBuilder::default().sketch(&["def", "("]);
        assert!(sketch.minhash.iter().all(|&v| v == u32::MAX));
        assert_eq!(sketch.token_count, 2);
    }

    #[test]
    fn repeated_trigrams_count_once() {
        let mut builder = SketchBuilder::default();
        // Both streams hold exactly the trigrams xyz, yzx and zxy.
        let short = builder.sketch(&["x", "y", "z", "x", "y"]);
        let long = builder.sketch(&["x", "y", "z", "x", "y", "z", "x"]);
        assert_eq!(short.minhash, long.minhash);
        assert_eq!((short.token_count, long.token_count), (5, 7));
        // A new trigram can only lower a minimum.
        let more = builder.sketch(&["x", "y", "z", "x", "y", "w"]);
        assert!(
            more.minhash
                .iter()
                .zip(short.minhash.iter())
                .all(|(m, s)| m <= s)
        );
        assert_ne!(more.minhash, short.minhash);
    }

    #[test]
    fn body_hash_clamps_and_collapses() {
        let lines = ["def f():", "    return  1", ""];
        assert_eq!(
            body_hash(&lines, 1, 2),
            body_hash(&["def f(): return 1"], 1, 1)
        );
        assert_eq!(body_hash(&lines, 1, 99), body_hash(&lines, 1, 3));
    }
}
