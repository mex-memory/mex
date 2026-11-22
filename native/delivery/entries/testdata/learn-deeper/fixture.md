---
{
  "mex": {
    "id": "mx_deepaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "kind": "rule",
    "scope": [
      "src/**"
    ],
    "source": {
      "type": "docs",
      "ref": "README.md"
    },
    "evidence": "docs",
    "one_line": "Use the checked loader.",
    "checks": [
      {
        "kind": "fixture",
        "role": "complete",
        "target": {
          "pairs": [
            {
              "path": "src/load.ts",
              "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
              "before": {
                "start": 5,
                "end": 5,
                "text": "loadRaw(input)",
                "hash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
              },
              "after": {
                "start": 5,
                "end": 5,
                "text": "loadSafe(input)",
                "hash": "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
              }
            }
          ],
          "proves": [
            0,
            1
          ]
        },
        "saw": {
          "ok": true
        },
        "files": {}
      }
    ],
    "status": "active",
    "created": "2026-11-23",
    "when": [
      {
        "type": "anti",
        "match": "literal",
        "pattern": "loadRaw"
      },
      {
        "type": "required",
        "match": "structural",
        "pattern": "loadSafe($ARG)"
      }
    ]
  }
}
---
Use the checked loader. It validates input.
