//! The shared node-id vectors: every identity and id TypeScript produces for
//! `id-vectors.json` must come out of the Rust port byte for byte. The
//! TypeScript side runs the same file in
//! `src/graph/__tests__/engine-id-vectors.test.ts`.

use mex_graph_core::id::{node_id, ordinal_identity, signature_identity};
use serde_json::Value;

#[test]
fn rust_ids_equal_typescript_ids() {
    let text = include_str!("id-vectors.json");
    let vectors: Vec<Value> = serde_json::from_str(text).expect("valid vectors");
    assert!(vectors.len() >= 20, "the vector file lost cases");
    for vector in &vectors {
        let input = &vector["input"];
        let s = |key: &str| input[key].as_str().unwrap_or_default();
        let identity = match s("profile") {
            "signature" => signature_identity(
                s("path"),
                s("kind"),
                s("qualifiedName"),
                input["declarationRole"].as_str(),
                s("signature"),
            ),
            "ordinal" => ordinal_identity(
                s("path"),
                s("kind"),
                s("qualifiedName"),
                s("declarationRole"),
                input["ordinal"]
                    .as_u64()
                    .map(|n| u32::try_from(n).expect("small ordinal")),
            ),
            other => panic!("unknown profile {other}"),
        };
        assert_eq!(
            identity,
            vector["identity"].as_str().unwrap(),
            "identity for {input}"
        );
        assert_eq!(
            node_id(s("kind"), &identity),
            vector["id"].as_str().unwrap(),
            "id for {input}"
        );
    }
}
