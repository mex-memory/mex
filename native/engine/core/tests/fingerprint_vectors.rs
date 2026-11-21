//! Body hashes, MinHash sketches and JavaScript string cuts must equal what
//! TypeScript computes for `fingerprint-vectors.json`
//! (`src/graph/__tests__/engine-fingerprint-vectors.test.ts`).

use mex_graph_core::fingerprint::{SketchBuilder, body_hash};
use mex_graph_core::text::js_slice;
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!("fingerprint-vectors.json")).expect("valid vectors")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[test]
fn body_hashes_equal_typescript() {
    for case in vectors()["bodies"].as_array().unwrap() {
        let source = case["source"].as_str().unwrap();
        let lines: Vec<&str> = source.split('\n').collect();
        let start = case["start"].as_u64().unwrap() as usize;
        let end = case["end"].as_u64().unwrap() as usize;
        assert_eq!(
            hex(&body_hash(&lines, start, end)),
            case["hash"].as_str().unwrap(),
            "{case}"
        );
    }
}

#[test]
fn sketches_equal_typescript() {
    let mut builder = SketchBuilder::default();
    for case in vectors()["sketches"].as_array().unwrap() {
        let tokens: Vec<&str> = case["tokens"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t.as_str().unwrap())
            .collect();
        let sketch = builder.sketch(&tokens);
        let expected: Vec<u32> = case["minhash"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u32)
            .collect();
        assert_eq!(sketch.minhash.to_vec(), expected, "tokens {tokens:?}");
        assert_eq!(
            sketch.token_count as u64,
            case["tokenCount"].as_u64().unwrap()
        );
    }
}

#[test]
fn string_cuts_equal_javascript() {
    for case in vectors()["slices"].as_array().unwrap() {
        let cut = js_slice(
            case["text"].as_str().unwrap(),
            case["units"].as_u64().unwrap() as usize,
        );
        assert_eq!(
            hex(cut.as_bytes()),
            case["utf8Hex"].as_str().unwrap(),
            "{case}"
        );
    }
}
