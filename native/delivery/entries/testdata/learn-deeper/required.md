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
    "checks": [],
    "status": "active",
    "created": "2026-11-23",
    "when": [
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
