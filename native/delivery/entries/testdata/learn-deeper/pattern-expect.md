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
        "kind": "pattern",
        "role": "complete",
        "target": {
          "scope": "src/**",
          "pattern": "loadSafe",
          "expect": "present"
        },
        "saw": {
          "count": 1
        },
        "files": {}
      }
    ],
    "status": "active",
    "created": "2026-11-23"
  }
}
---
Use the checked loader. It validates input.
